#!/usr/bin/env node

/**
 * contact-extract.mjs — discover a recruiter/interviewer contact from a pasted
 * reply, and save it to data/contacts.tsv for a later re-engagement follow-up
 * (#4361).
 *
 * Problem this closes: once a role goes to Rejected, whatever recruiter or
 * interviewer identity passed through an interview invite or rejection email
 * is effectively gone. There is no path from "I had a good interview with
 * this person months ago" to "here is their email, drafted into a follow-up"
 * when a new, different opening appears at the same company later.
 *
 * This is the CORE (local-only, no Gmail dependency) layer of #4361's
 * two-layer design. It reuses the exact input shape paste-reply.mjs already
 * established (#1802) — paste an email's Subject/From/body, or read it from a
 * file — so anyone who doesn't want to grant any tool mailbox access can
 * still use it. The opt-in Gmail-plugin layer (#1583) is future work and can
 * feed this same pipeline once it exists, because both produce the identical
 * {subject, from, body} shape this script already consumes.
 *
 * What it does, in order:
 *   1. Parse the pasted email into {subject, from, body} (via
 *      paste-reply.mjs's parseFileInput/collectInteractive — no duplicated
 *      parsing logic).
 *   2. Parse the From header into {name, email} (parseFromHeader).
 *   3. Match the email to a tracker row using reply-matcher.mjs's own
 *      matchCandidates() — the same matcher reply-watch.mjs already trusts —
 *      so this never re-implements company/role matching.
 *   4. Classify the reply (classifyReply) and infer a contact `type`
 *      (recruiter / hiring-manager / interviewer) from the email text.
 *   5. Confirm with the user (or --yes for non-interactive use) before
 *      appending one row to data/contacts.tsv.
 *
 * This script NEVER writes to data/applications.md, NEVER sends anything, and
 * NEVER classifies or updates tracker status — same boundary as
 * paste-reply.mjs and reply-watch.mjs. A tracker row is required to attach the
 * contact to (via auto-match or an explicit --company/--tracker override);
 * without one, nothing is written and the script exits 0 with an explanation.
 *
 * Usage:
 *   node contact-extract.mjs --file email.txt
 *   node contact-extract.mjs --file email.txt --yes
 *   node contact-extract.mjs --file email.txt --company "Acme Inc" --tracker 42
 *   node contact-extract.mjs --file email.txt --type interviewer
 *   node contact-extract.mjs                      # interactive, same prompts as paste-reply.mjs
 *   node contact-extract.mjs --help
 *
 * --file format is identical to paste-reply.mjs's:
 *   Subject: <subject line>
 *   From: <sender name and/or email>
 *
 *   <body text, any number of lines>
 *
 * Env:
 *   CAREER_OPS_CONTACTS  override the output TSV path (used by tests;
 *                        defaults to data/contacts.tsv under the resolved
 *                        career-ops data root, matching contacts.mjs)
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { renameSyncWithRetry, resolveTrackerPath } from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { validateFlags, hasFlag, flagValue } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { parseFileInput, collectInteractive } from './paste-reply.mjs';
import { matchCandidates, classifyReply } from './reply-matcher.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';

const DATA_ROOT = getCareerOpsRoot();
const CONTACTS_PATH = process.env.CAREER_OPS_CONTACTS
  || path.join(DATA_ROOT, 'data', 'contacts.tsv');
const APPS_FILE = resolveTrackerPath(DATA_ROOT);
const FOLLOWUPS_FILE = path.join(DATA_ROOT, 'data', 'follow-ups.md');

// Kept in sync by hand with contacts.mjs's own VALID_TYPES — both are small,
// stable enums describing the same TSV column, and contacts.mjs does not
// export its copy.
const VALID_TYPES = new Set(['recruiter', 'hiring-manager', 'peer', 'interviewer', 'other']);

const KNOWN_FLAGS = ['--file', '--yes', '--company', '--tracker', '--type', '--help', '-h'];
const USAGE = `Usage:
  node contact-extract.mjs --file <path>                     read subject/from/body from a file
  node contact-extract.mjs                                   interactive: prompts for subject, from, body
  node contact-extract.mjs --file <path> --yes                skip the confirm-before-write prompt
  node contact-extract.mjs --file <path> --company "Acme Inc" --tracker 42
                                                               attach to a specific tracker row when
                                                               auto-matching finds none or is ambiguous
  node contact-extract.mjs --file <path> --type interviewer   override the inferred contact type
  node contact-extract.mjs --help`;

/**
 * Parse an email "From:" header into {name, email}. Handles the three shapes
 * real mail clients produce: `"Name" <email>`, `Name <email>`, and a bare
 * address with no display name. A value that is neither is treated as a bare
 * name with no email (still useful — a contact can be saved without one, just
 * not looked up for a follow-up draft later).
 *
 * Exported for direct unit testing.
 */
export function parseFromHeader(from) {
  if (!from || !from.trim()) return { name: '', email: null };
  const angleMatch = from.match(/^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/);
  if (angleMatch) {
    const email = angleMatch[2].trim();
    return {
      name: angleMatch[1].trim(),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : null,
    };
  }
  const trimmed = from.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { name: '', email: trimmed.toLowerCase() };
  }
  return { name: trimmed, email: null };
}

/**
 * Infer a contacts.tsv `type` value from the reply text. Defaults to
 * 'recruiter' — the common case for an interview-invite or rejection sender —
 * and only overrides that when the body itself names a more specific role.
 * Checked in this order because a rejection sent BY a hiring manager who
 * calls themselves that in the signature is a stronger, more specific signal
 * than a generic mention of "the interview panel" elsewhere in the same email.
 *
 * Exported for direct unit testing.
 */
export function inferContactType(text) {
  const t = (text || '').toLowerCase();
  if (/\bhiring manager\b/.test(t)) return 'hiring-manager';
  if (/\b(interview panel|interview team|panelist|panellist|interviewer)\b/.test(t)) return 'interviewer';
  return 'recruiter';
}

/** One TSV cell must never contain a tab or newline — either would shift or
 * split the row. Exported for direct unit testing. */
export function sanitizeCell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * Append one contact row to data/contacts.tsv, creating the file (with its
 * documented leading `#` header-comment line) if it doesn't exist yet, and
 * never disturbing existing rows. Write-then-rename, same pattern as
 * paste-reply.mjs's appendCandidate, so a crash mid-write can never leave the
 * real file truncated or corrupted.
 *
 * Exported for direct unit testing. Returns the file's total data-row count
 * after the append.
 */
export function appendContact(contact, contactsPath = CONTACTS_PATH) {
  const row = [
    contact.name, contact.company, contact.type, contact.title || '',
    contact.phone || '', contact.email || '', contact.linkedin || '',
    contact.tracker || '-', contact.notes || '',
  ].map(sanitizeCell).join('\t');

  let existing = '';
  let dataRows = 0;
  if (fs.existsSync(contactsPath)) {
    existing = fs.readFileSync(contactsPath, 'utf-8');
    for (const line of existing.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#')) dataRows++;
    }
    if (existing && !existing.endsWith('\n')) existing += '\n';
  } else {
    fs.mkdirSync(path.dirname(contactsPath), { recursive: true });
    existing = '# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker\tnotes\n';
  }

  const updated = `${existing}${row}\n`;
  const tmpPath = `${contactsPath}.tmp`;
  fs.writeFileSync(tmpPath, updated, 'utf-8');
  renameSyncWithRetry(tmpPath, contactsPath);
  return dataRows + 1;
}

function loadTrackerApps(appsFile = APPS_FILE) {
  if (!fs.existsSync(appsFile)) return [];
  const content = fs.readFileSync(appsFile, 'utf-8');
  const lines = content.split('\n');
  const colmap = resolveColumns(lines);
  const apps = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) apps.push(row);
  }
  return apps;
}

function loadFollowups(followupsFile = FOLLOWUPS_FILE) {
  if (!fs.existsSync(followupsFile)) return [];
  const content = fs.readFileSync(followupsFile, 'utf-8');
  const lines = content.split('\n');
  const followups = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map((s) => s.trim());
    if (parts.length < 8) continue;
    const num = parseInt(parts[1], 10);
    const appNum = parseInt(parts[2], 10);
    if (Number.isNaN(num) || Number.isNaN(appNum)) continue;
    followups.push({
      num, appNum, date: parts[3], company: parts[4], role: parts[5],
      channel: parts[6], contact: parts[7], notes: parts[8] || '',
    });
  }
  return followups;
}

function askYesNo(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    // EOF on stdin (piped input that ends without a line) fires 'close'
    // without ever invoking the question callback below — decline rather
    // than hang forever waiting for an answer that will never arrive.
    rl.on('close', () => { if (!answered) resolve(false); });
    rl.question(query, (ans) => {
      answered = true;
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

function printHelp() {
  console.log(`contact-extract.mjs — discover a recruiter/interviewer contact from a pasted reply and save it to data/contacts.tsv (#4361)

${USAGE}

Never touches data/applications.md, never sends anything, never classifies or
updates tracker status. Requires a tracker row to attach the contact to (via
auto-match against data/applications.md, or an explicit --company/--tracker
override); without one, nothing is written.`);
}

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, {
    valueFlags: ['--file', '--company', '--tracker', '--type'],
    requireOperand: true,
  });

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const filePath = flagValue(args, '--file');
  let input;
  if (filePath !== undefined) {
    if (!fs.existsSync(filePath)) {
      console.error(`Error: file not found: ${filePath}`);
      process.exitCode = 1;
      return;
    }
    input = parseFileInput(fs.readFileSync(filePath, 'utf-8'));
  } else {
    input = await collectInteractive();
  }

  if (!input.subject && !input.body) {
    console.error('Error: no subject or body text found — nothing to extract.');
    process.exitCode = 1;
    return;
  }

  const { name, email } = parseFromHeader(input.from);
  const candidate = {
    message_id: `extract-${Date.now()}`,
    from: input.from || '',
    subject: input.subject || '',
    body_snippet: input.body || '',
    signal: null,
  };

  const companyOverride = flagValue(args, '--company');
  const trackerOverride = flagValue(args, '--tracker');
  const apps = loadTrackerApps();

  let company = companyOverride;
  let trackerNum;

  if (trackerOverride !== undefined) {
    const trackerNumber = Number(trackerOverride.trim());
    if (!/^\d+$/.test(trackerOverride.trim()) || !Number.isSafeInteger(trackerNumber)
      || !apps.some((app) => app.num === trackerNumber)) {
      console.error(`Error: --tracker must name an existing tracker row; got "${trackerOverride}"`);
      process.exitCode = 1;
      return;
    }
    trackerNum = String(trackerNumber);
  }

  if (!company || !trackerNum) {
    const followups = loadFollowups();
    const [match] = matchCandidates([candidate], apps, followups);
    if (match && match.application_num != null) {
      company = company || match.company_hint;
      trackerNum = trackerNum || String(match.application_num);
    }
  }

  if (!company || !trackerNum) {
    console.log('Could not match this reply to a single tracker row, and no --company/--tracker override was given.');
    console.log('Nothing was written to data/contacts.tsv. Re-run with --company "<name>" --tracker <num> to attach it manually.');
    return;
  }

  const typeOverride = flagValue(args, '--type');
  if (typeOverride && !VALID_TYPES.has(typeOverride)) {
    console.error(`Error: --type must be one of ${[...VALID_TYPES].join(', ')}; got "${typeOverride}"`);
    process.exitCode = 1;
    return;
  }
  const contactType = typeOverride || inferContactType(`${candidate.subject} ${candidate.body_snippet}`);

  const replyType = classifyReply(candidate).type;
  const today = new Date().toISOString().slice(0, 10);
  const contact = {
    name,
    company,
    type: contactType,
    email,
    tracker: trackerNum,
    notes: `extracted from pasted reply, ${today}; reply type: ${replyType}`,
  };

  console.log('\nDiscovered contact:');
  console.log(`  name:     ${contact.name || '(none)'}`);
  console.log(`  email:    ${contact.email || '(none)'}`);
  console.log(`  company:  ${contact.company}`);
  console.log(`  type:     ${contact.type}`);
  console.log(`  tracker#: ${contact.tracker}`);

  if (!contact.name && !contact.email) {
    console.log('\nNeither a name nor an email could be parsed from the From header — nothing useful to save.');
    return;
  }

  const skipConfirm = hasFlag(args, '--yes');
  if (!skipConfirm) {
    const proceed = await askYesNo('\nSave this contact to data/contacts.tsv? [y/N] ');
    if (!proceed) {
      console.log('Not saved.');
      return;
    }
  }

  const total = appendContact(contact);
  console.log(`\nSaved. data/contacts.tsv now has ${total} contact row(s).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
