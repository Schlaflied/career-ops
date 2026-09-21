#!/usr/bin/env node

/**
 * contact-extract-tests.mjs — regression tests for contact-extract.mjs (#4361).
 *
 * Locks in the local-only, no-Gmail path from a pasted interview-invite or
 * rejection email to a saved data/contacts.tsv row:
 *   1. parseFromHeader handles "Name" <email>, Name <email>, bare email, bare
 *      name, and normalizes/lowercases the email.
 *   2. inferContactType defaults to recruiter, and recognizes hiring-manager /
 *      interviewer signals in the reply text (hiring-manager wins when both
 *      are present, as the more specific signal).
 *   3. sanitizeCell strips tabs/newlines so a TSV row can never be corrupted
 *      by name/notes content.
 *   4. appendContact creates the file with its documented header comment,
 *      appends without disturbing existing rows, and sanitizes on the way in.
 *   5. CLI end to end: auto-match via reply-matcher.mjs's matchCandidates,
 *      manual --company/--tracker override, no-match no-op (nothing written,
 *      exit 0), --type validation, interactive y/n confirm vs --yes,
 *      missing-file / unknown-flag / --help exits.
 *
 * Provisions a throwaway tracker + contacts.tsv via CAREER_OPS_TRACKER /
 * CAREER_OPS_CONTACTS and a temp dir; never touches the repo's real
 * data/applications.md or data/contacts.tsv.
 */

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const CLI = join(ROOT, 'contact-extract.mjs');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setupWorkspace() {
  const dir = tmp('contact-extract-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const trackerFile = join(dataDir, 'applications.md');
  const header = '# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n';
  writeFileSync(trackerFile, `${header}| 12 | 2026-06-01 | Acme Inc | Backend Engineer | 4.0/5 | Applied | ❌ | - | |\n`);
  const contactsFile = join(dataDir, 'contacts.tsv');
  return { dir, trackerFile, contactsFile };
}

function writeEmail(dir, { subject = '', from = '', body = '' }) {
  const filePath = join(dir, 'email.txt');
  writeFileSync(filePath, `Subject: ${subject}\nFrom: ${from}\n\n${body}\n`);
  return filePath;
}

function run(trackerFile, contactsFile, args, input) {
  try {
    const stdout = execFileSync(NODE, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, CAREER_OPS_TRACKER: trackerFile, CAREER_OPS_CONTACTS: contactsFile },
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// ---------------------------------------------------------------------------
console.log('1. parseFromHeader / inferContactType / sanitizeCell — direct unit imports');
{
  const mod = await import(pathToFileURL(CLI).href);

  check('parseFromHeader: "Name" <email>', JSON.stringify(mod.parseFromHeader('"Jane Doe" <jane@acme.com>')) === JSON.stringify({ name: 'Jane Doe', email: 'jane@acme.com' }));
  check('parseFromHeader: Name <email> no quotes', JSON.stringify(mod.parseFromHeader('Jane Doe <jane@acme.com>')) === JSON.stringify({ name: 'Jane Doe', email: 'jane@acme.com' }));
  check('parseFromHeader: bare email', JSON.stringify(mod.parseFromHeader('jane@acme.com')) === JSON.stringify({ name: '', email: 'jane@acme.com' }));
  check('parseFromHeader: bare name, no email', JSON.stringify(mod.parseFromHeader('Jane from Acme Recruiting')) === JSON.stringify({ name: 'Jane from Acme Recruiting', email: null }));
  check('parseFromHeader: empty/missing', JSON.stringify(mod.parseFromHeader('')) === JSON.stringify({ name: '', email: null }) && JSON.stringify(mod.parseFromHeader(undefined)) === JSON.stringify({ name: '', email: null }));
  check('parseFromHeader: email lowercased', JSON.stringify(mod.parseFromHeader('Jane Doe <Jane@ACME.com>')) === JSON.stringify({ name: 'Jane Doe', email: 'jane@acme.com' }));

  check('inferContactType: hiring manager', mod.inferContactType('Regards, the Hiring Manager for this role') === 'hiring-manager');
  check('inferContactType: interview panel', mod.inferContactType('the interview panel has decided to move forward') === 'interviewer');
  check('inferContactType: interview team', mod.inferContactType('our interview team enjoyed meeting you') === 'interviewer');
  check('inferContactType: defaults to recruiter', mod.inferContactType('Thank you for applying to Acme Inc.') === 'recruiter');
  check('inferContactType: hiring-manager checked before interviewer', mod.inferContactType('the interview panel has decided; message from your hiring manager') === 'hiring-manager');

  check('sanitizeCell strips tabs/newlines, trims', mod.sanitizeCell('  Jane\tDoe\n ') === 'Jane Doe');
  check('sanitizeCell handles null/undefined', mod.sanitizeCell(null) === '' && mod.sanitizeCell(undefined) === '');
}

// ---------------------------------------------------------------------------
console.log('2. appendContact — direct unit import');
{
  const mod = await import(pathToFileURL(CLI).href);

  const dir1 = tmp('contact-extract-append-');
  const contactsPath1 = join(dir1, 'data', 'contacts.tsv');
  const total1 = mod.appendContact({ name: 'Jane Doe', company: 'Acme', type: 'recruiter', email: 'jane@acme.com', tracker: '12', notes: 'test' }, contactsPath1);
  check('appendContact: returns 1 on first write', total1 === 1, `got ${total1}`);
  const content1 = readFileSync(contactsPath1, 'utf8');
  check('appendContact: creates header comment line', content1.startsWith('# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker\tnotes\n'), content1);
  check('appendContact: row has expected fields', content1.includes('Jane Doe\tAcme\trecruiter\t\t\tjane@acme.com\t\t12\ttest\n'), content1);

  const dir2 = tmp('contact-extract-append-');
  const contactsPath2 = join(dir2, 'data', 'contacts.tsv');
  mkdirSync(join(dir2, 'data'), { recursive: true });
  writeFileSync(contactsPath2, '# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker\tnotes\nExisting Person\tOldCo\tpeer\t\t\t\t\t-\t\n');
  const total2 = mod.appendContact({ name: 'Jane Doe', company: 'Acme', type: 'interviewer', email: '', tracker: '-', notes: '' }, contactsPath2);
  check('appendContact: returns 2 when one row already existed', total2 === 2, `got ${total2}`);
  const lines2 = readFileSync(contactsPath2, 'utf8').trim().split('\n');
  check('appendContact: existing row untouched, new row appended after it', lines2.length === 3 && lines2[1].startsWith('Existing Person') && lines2[2].startsWith('Jane Doe'), lines2.join(' | '));

  const dir3 = tmp('contact-extract-append-');
  const contactsPath3 = join(dir3, 'data', 'contacts.tsv');
  mod.appendContact({ name: 'Jane\tDoe', company: 'Acme', type: 'recruiter', email: '', tracker: '-', notes: 'line1\nline2' }, contactsPath3);
  const lines3 = readFileSync(contactsPath3, 'utf8').trim().split('\n');
  check('appendContact: tab/newline-bearing fields sanitized to 9 clean cells', lines3.length === 2 && lines3[1].split('\t').length === 9, lines3[1]);
}

// ---------------------------------------------------------------------------
console.log('3. CLI: auto-matches company + role via reply-matcher.mjs and saves with --yes');
{
  const { dir, trackerFile, contactsFile } = setupWorkspace();
  const emailFile = writeEmail(dir, {
    subject: 'Acme Inc — Backend Engineer: interview invitation',
    from: 'Jane Doe <jane@acme.com>',
    body: 'We would like to invite you to interview for the Backend Engineer role.',
  });

  const res = run(trackerFile, contactsFile, ['--file', emailFile, '--yes']);
  check('exit 0', res.status === 0, res.stderr);
  check('contacts.tsv created', existsSync(contactsFile));
  const content = existsSync(contactsFile) ? readFileSync(contactsFile, 'utf8') : '';
  check('row has matched company + inferred recruiter type + tracker#12', content.includes('Jane Doe\tAcme Inc\trecruiter\t\t\tjane@acme.com\t\t12\t'), content);
}

// ---------------------------------------------------------------------------
console.log('4. CLI: no auto-match and no override writes nothing, exits 0');
{
  const { dir, trackerFile, contactsFile } = setupWorkspace();
  const emailFile = writeEmail(dir, {
    subject: 'Weekly digest of open roles you might like',
    from: 'noreply@somewhereelse.com',
    body: 'Check out these fresh opportunities curated just for you this week.',
  });

  const res = run(trackerFile, contactsFile, ['--file', emailFile, '--yes']);
  check('exit 0 even with no match', res.status === 0, res.stderr);
  check('contacts.tsv NOT created', !existsSync(contactsFile));
}

// ---------------------------------------------------------------------------
console.log('5. CLI: --company/--tracker override bypasses auto-match');
{
  const { dir, trackerFile, contactsFile } = setupWorkspace();
  const emailFile = writeEmail(dir, {
    subject: 'Totally unrelated newsletter',
    from: 'Jane Doe <jane@acme.com>',
    body: 'No matching keywords here at all.',
  });

  const res = run(trackerFile, contactsFile, ['--file', emailFile, '--yes', '--company', 'Acme Inc', '--tracker', '12']);
  check('exit 0', res.status === 0, res.stderr);
  const content = existsSync(contactsFile) ? readFileSync(contactsFile, 'utf8') : '';
  check('override company/tracker used', content.includes('Jane Doe\tAcme Inc\trecruiter\t\t\tjane@acme.com\t\t12\t'), content);
}

// ---------------------------------------------------------------------------
console.log('6. CLI: --type overrides the inferred type');
{
  const { dir, trackerFile, contactsFile } = setupWorkspace();
  const emailFile = writeEmail(dir, {
    subject: 'Acme Inc — Backend Engineer',
    from: 'Jane Doe <jane@acme.com>',
    body: 'Backend Engineer interview follow-up.',
  });

  const res = run(trackerFile, contactsFile, ['--file', emailFile, '--yes', '--type', 'interviewer']);
  check('exit 0', res.status === 0, res.stderr);
  const content = existsSync(contactsFile) ? readFileSync(contactsFile, 'utf8') : '';
  check('type overridden to interviewer', content.includes('Jane Doe\tAcme Inc\tinterviewer\t'), content);
}

// ---------------------------------------------------------------------------
console.log('7. CLI: unknown --type value exits 1 and writes nothing');
{
  const { dir, trackerFile, contactsFile } = setupWorkspace();
  const emailFile = writeEmail(dir, { subject: 'Acme Inc — Backend Engineer', from: 'jane@acme.com', body: 'Backend Engineer.' });

  const res = run(trackerFile, contactsFile, ['--file', emailFile, '--yes', '--type', 'bogus']);
  check('exit 1', res.status === 1, `status=${res.status}`);
  check('contacts.tsv not created', !existsSync(contactsFile));
}

// ---------------------------------------------------------------------------
console.log('8. CLI: interactive confirm — "n" does not save, "y" saves');
{
  const w1 = setupWorkspace();
  const emailFile1 = writeEmail(w1.dir, { subject: 'Acme Inc — Backend Engineer', from: 'jane@acme.com', body: 'Backend Engineer interview.' });
  const resNo = run(w1.trackerFile, w1.contactsFile, ['--file', emailFile1], 'n\n');
  check('"n": exit 0', resNo.status === 0, resNo.stderr);
  check('"n": nothing saved', !existsSync(w1.contactsFile));

  const w2 = setupWorkspace();
  const emailFile2 = writeEmail(w2.dir, { subject: 'Acme Inc — Backend Engineer', from: 'jane@acme.com', body: 'Backend Engineer interview.' });
  const resYes = run(w2.trackerFile, w2.contactsFile, ['--file', emailFile2], 'y\n');
  check('"y": exit 0', resYes.status === 0, resYes.stderr);
  check('"y": saved', existsSync(w2.contactsFile));
}

// ---------------------------------------------------------------------------
console.log('9. CLI: neither name nor email parsed — nothing saved even with --yes');
{
  const { dir, trackerFile, contactsFile } = setupWorkspace();
  const emailFile = join(dir, 'email.txt');
  writeFileSync(emailFile, 'Subject: Acme Inc — Backend Engineer\n\nBackend Engineer interview.\n');

  const res = run(trackerFile, contactsFile, ['--file', emailFile, '--yes']);
  check('exit 0', res.status === 0, res.stderr);
  check('nothing saved (empty From header)', !existsSync(contactsFile));
}

// ---------------------------------------------------------------------------
console.log('10. CLI: missing --file path / unknown flag / --help');
{
  const { dir, trackerFile, contactsFile } = setupWorkspace();

  const resMissing = run(trackerFile, contactsFile, ['--file', join(dir, 'does-not-exist.txt')]);
  check('missing --file path exits 1', resMissing.status === 1, `status=${resMissing.status}`);

  const resBogus = run(trackerFile, contactsFile, ['--bogus']);
  check('unrecognized flag exits 1', resBogus.status === 1, `status=${resBogus.status}`);

  const resHelp = run(trackerFile, contactsFile, ['--help']);
  check('--help exits 0', resHelp.status === 0, resHelp.stderr);
  check('--help prints usage', resHelp.stdout.includes('Usage:'), resHelp.stdout);
  check('--help writes nothing to contacts.tsv', !existsSync(contactsFile));
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
