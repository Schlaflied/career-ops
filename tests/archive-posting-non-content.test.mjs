// tests/archive-posting-non-content.test.mjs — archiveUrl() refuses to save a
// non-content capture (login wall / 404 shell / paywall / JS-required) rather
// than silently reporting success (#4526).
//
// check-jd-archive.mjs's detectNonContentMarker() already recognizes these
// shapes, but only at AUDIT time — well after a bad capture is already sitting
// in jds/. This exercises the REAL archiveUrl() (no mocking of the detection
// logic itself), driven through a fake Playwright browser/context/page rather
// than a real one: archive-posting.mjs has no dedicated test suite of its own
// anywhere in this repo, precisely because it does real network navigation
// through a real headless browser, and a unit test that launched Chromium
// against a live URL would be flaky, slow, and network-dependent for no
// benefit. The fake page satisfies exactly the Playwright surface
// archiveUrl() calls (goto/url/title/$eval/waitForTimeout/evaluate/pdf) so the
// REAL function logic runs end to end; only the browser layer underneath it
// is faked. CAREER_OPS_ROOT is set to a temp dir BEFORE import, so JDS_DIR
// resolves there instead of the real project's jds/.
//
// Run:  node --test tests/archive-posting-non-content.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'career-ops-archive-nc-'));
process.env.CAREER_OPS_ROOT = tmp;

const { archiveUrl } = await import('../archive-posting.mjs');

function makeFakeBrowser({ bodyText, title = 'Backend Engineer | Acme', h1 = 'Backend Engineer', httpStatus = 200 }) {
  let pdfCalled = false;
  const page = {
    _landedUrl: null,
    async goto(url) { page._landedUrl = url; return { status: () => httpStatus }; },
    url() { return page._landedUrl; },
    async waitForTimeout() {},
    async title() { return title; },
    async $eval(selector) {
      if (selector !== 'h1') throw new Error(`fake page has no selector ${selector}`);
      if (h1 == null) throw new Error('no h1 in fixture');
      return h1;
    },
    // Real Playwright serializes and runs the passed function IN the page.
    // The fake can't execute page-context code, so it just returns the
    // controlled fixture text — testing archiveUrl()'s reaction to the
    // extracted text is the point here, not Playwright's own extraction.
    async evaluate() { return bodyText; },
    async pdf() { pdfCalled = true; return Buffer.from('%PDF-fake'); },
  };
  const context = {
    async newPage() { return page; },
    async close() {},
    // installEgressGuard() registers a route handler on every real Playwright
    // context; the fake only needs to accept the call, since the guard's own
    // logic (rejectPrivateOrInvalid / validateUrlSecurity) is exercised on the
    // real navigation URL passed to archiveUrl(), not through this handler.
    async route() {},
  };
  const browser = { async newContext() { return context; } };
  return { browser, pdfCalled: () => pdfCalled };
}

const jdsFiles = () => (existsSync(join(tmp, 'jds')) ? readdirSync(join(tmp, 'jds')) : []);

test('a login-wall page is refused, not archived', async () => {
  const { browser, pdfCalled } = makeFakeBrowser({ bodyText: 'Sign in to view this job. Join LinkedIn to see who you know at Acme.' });
  await assert.rejects(
    () => archiveUrl(browser, 'https://boards.greenhouse.io/acme/jobs/1', {}),
    /refusing to archive.*sign-in\/login wall/i,
  );
  assert.equal(pdfCalled(), false, 'a login-wall page must never reach page.pdf()');
  assert.deepEqual(jdsFiles(), [], 'nothing was written to jds/');
});

test('a 404 shell is refused, not archived', async () => {
  const { browser, pdfCalled } = makeFakeBrowser({ bodyText: '404 Not Found — this job posting is no longer available.' });
  await assert.rejects(
    () => archiveUrl(browser, 'https://boards.greenhouse.io/acme/jobs/2', {}),
    /refusing to archive.*404/i,
  );
  assert.equal(pdfCalled(), false);
});

test('a real posting is archived normally (control)', async () => {
  const { browser, pdfCalled } = makeFakeBrowser({
    bodyText: 'We are looking for a Senior Backend Engineer to join our platform team and own the checkout service end to end. Requirements: 5+ years experience.',
  });
  const result = await archiveUrl(browser, 'https://boards.greenhouse.io/acme/jobs/3', {});
  assert.equal(pdfCalled(), true, 'a real posting must still be captured');
  assert.match(result.filename, /\.pdf$/);
  assert.ok(jdsFiles().includes(result.filename), 'the file was actually written to jds/');
});

test('empty body text (extraction failed) is not treated as a false-positive marker', async () => {
  // page.evaluate()'s own .catch(() => '') fallback in archiveUrl() means an
  // extraction failure looks identical to an empty page here — neither should
  // ever match a NON_CONTENT_MARKERS pattern, so this must NOT be refused.
  const { browser, pdfCalled } = makeFakeBrowser({ bodyText: '' });
  await archiveUrl(browser, 'https://boards.greenhouse.io/acme/jobs/4', {});
  assert.equal(pdfCalled(), true, 'empty extracted text must not be mistaken for a non-content marker');
});

process.on('exit', () => rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));
