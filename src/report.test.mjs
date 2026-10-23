/**
 * Tests for the PDF report. Run with:  npm test
 *
 * These check that the report is a structurally valid PDF, that it is
 * reproducible, and that the figures a scrutineer needs actually appear in the
 * rendered text.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OUTCOME_ELECTED, OUTCOME_REFERRAL, runCount } from './counting.js';
import { buildCountReport } from './report.js';
import { measureText, toWinAnsi, wrapText } from './pdf.js';

const FIXED_TIME = new Date('2026-10-22T04:30:00.000Z');

const candidatesFrom = (...names) => names.map((name) => ({ id: name.toLowerCase(), name }));

const ballot = (serial, order, extra = {}) => ({
  serial,
  marks: Object.fromEntries(
    order
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((name, index) => [name.toLowerCase(), String(index + 1)]),
  ),
  ...extra,
});

const ballotsFrom = (spec) => {
  const result = [];
  spec.forEach(([order, count]) => {
    for (let index = 0; index < count; index += 1) {
      result.push(ballot(result.length + 1, order));
    }
  });
  return result;
};

const buildFor = ({ names, spec, positionTitle = 'President', electionTypeId = 'elected', extraBallots = [] }) => {
  const candidates = candidatesFrom(...names);
  const ballots = [...ballotsFrom(spec), ...extraBallots];
  const result = runCount({ candidates, ballots, electionTypeId });

  return {
    result,
    ballots,
    report: buildCountReport({
      result,
      positionTitle,
      ballots,
      returningOfficer: 'A. Returning-Officer',
      scrutineers: 'S. One, S. Two',
      generatedAt: FIXED_TIME,
    }),
  };
};

const asText = (bytes) => Buffer.from(bytes).toString('latin1');

/** Pull the text drawn by every `(...) Tj` operator, in page order. */
const renderedText = (bytes) =>
  [...asText(bytes).matchAll(/\((.*?)\) Tj/g)]
    .map((match) => match[1].replace(/\\([\\()])/g, '$1'))
    .join('\n');

/** The same text with wrapping collapsed, for matching prose across line breaks. */
const flatText = (bytes) => renderedText(bytes).replace(/\s+/g, ' ');

/* ---------------------------------------------------------------- *
 * PDF structure
 * ---------------------------------------------------------------- */

test('the report is a structurally valid PDF', () => {
  const { report } = buildFor({ names: ['Alice', 'Bob', 'Carol'], spec: [['Alice,Bob,Carol', 6], ['Bob,Alice,Carol', 3], ['Carol,Alice,Bob', 2]] });
  const text = asText(report.bytes);

  assert.ok(text.startsWith('%PDF-1.4'), 'must carry a PDF header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'must carry a PDF trailer');
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Type \/Pages/);
  assert.match(text, /\/Type \/Page\b/);
  assert.match(text, /startxref\n\d+\n%%EOF/);
});

test('every cross-reference offset points at its object', () => {
  const { report } = buildFor({ names: ['Alice', 'Bob'], spec: [['Alice,Bob', 3], ['Bob,Alice', 1]] });
  const text = asText(report.bytes);

  const xrefStart = Number(text.match(/startxref\n(\d+)\n%%EOF/)[1]);
  const xrefSection = text.slice(xrefStart);
  assert.ok(xrefSection.startsWith('xref\n'), 'startxref must land on the xref table');

  const entries = [...xrefSection.matchAll(/^(\d{10}) (\d{5}) n $/gm)].map((match) => Number(match[1]));
  assert.ok(entries.length >= 5, 'expected at least the catalog, pages, info and font objects');

  entries.forEach((offset, index) => {
    const objectId = index + 1;
    assert.ok(
      text.startsWith(`${objectId} 0 obj`, offset),
      `xref entry for object ${objectId} must point at "${objectId} 0 obj"`,
    );
  });
});

test('each content stream declares its true length', () => {
  const { report } = buildFor({
    names: ['Alice', 'Bob', 'Carol', 'Dave'],
    spec: [['Alice,Bob,Carol,Dave', 9], ['Bob,Carol,Alice,Dave', 7], ['Carol,Dave,Alice,Bob', 4], ['Dave,Alice,Bob,Carol', 3]],
  });
  const text = asText(report.bytes);

  const streams = [...text.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(streams.length > 0, 'expected at least one content stream');

  streams.forEach((match, index) => {
    assert.equal(Number(match[1]), match[2].length, `stream ${index} length must match its contents`);
  });
});

test('the report paginates and numbers its pages', () => {
  // A long ledger forces the ballot table across several pages.
  const { report } = buildFor({
    names: ['Alice', 'Bob', 'Carol'],
    spec: [['Alice,Bob,Carol', 70], ['Bob,Carol,Alice', 55], ['Carol,Bob,Alice', 40]],
  });
  const text = asText(report.bytes);

  const pageCount = [...text.matchAll(/\/Type \/Page\b/g)].length;
  assert.ok(pageCount >= 4, `expected a multi-page report, got ${pageCount}`);
  assert.match(text, new RegExp(`\\(Page 1 of ${pageCount}\\) Tj`));
  assert.match(text, new RegExp(`\\(Page ${pageCount} of ${pageCount}\\) Tj`));
});

test('the same count and timestamp produce byte-identical PDFs', () => {
  const first = buildFor({ names: ['Alice', 'Bob'], spec: [['Alice,Bob', 4], ['Bob,Alice', 1]] });
  const second = buildFor({ names: ['Alice', 'Bob'], spec: [['Alice,Bob', 4], ['Bob,Alice', 1]] });

  assert.equal(
    createHash('sha256').update(first.report.bytes).digest('hex'),
    createHash('sha256').update(second.report.bytes).digest('hex'),
    'the report must be reproducible so its own hash can be archived',
  );
});

test('the digest in the report matches SHA-256 of the exported record', () => {
  const { report } = buildFor({ names: ['Alice', 'Bob', 'Carol'], spec: [['Alice,Bob,Carol', 5], ['Bob,Alice,Carol', 4]] });

  assert.equal(report.digest.algorithm, 'SHA-256');
  assert.equal(
    report.digest.hex,
    createHash('sha256').update(report.record, 'utf8').digest('hex'),
    'an auditor running sha256sum on the exported record must get the printed digest',
  );
  assert.match(renderedText(report.bytes), new RegExp(report.digest.hex.slice(0, 32)));
});

/* ---------------------------------------------------------------- *
 * Report content
 * ---------------------------------------------------------------- */

test('an elected result publishes the declaration and per-candidate first preferences', () => {
  const { result, report } = buildFor({
    names: ['Alice', 'Bob', 'Carol'],
    spec: [['Alice,Bob,Carol', 6], ['Bob,Alice,Carol', 3], ['Carol,Alice,Bob', 2]],
  });
  const text = renderedText(report.bytes);

  assert.equal(result.outcome.status, OUTCOME_ELECTED);
  assert.match(text, /RESULT: CANDIDATE ELECTED/);
  assert.match(text, /Alice/);
  assert.match(text, /First preference votes/);

  // Each candidate's first preference figure must be on the page.
  assert.match(text, /Alice\n+6/, 'Alice had 6 first preferences');
  assert.match(text, /Bob\n+3/, 'Bob had 3 first preferences');
  assert.match(text, /Carol\n+2/, 'Carol had 2 first preferences');
  assert.match(text, /54\.5%/, 'share of formal ballots is published');
  assert.match(text, /TOTAL\n+11/, 'first preferences total to the formal ballots');
});

test('the report publishes round-by-round totals and the exclusion at each round', () => {
  const { report } = buildFor({
    names: ['Alice', 'Bob', 'Carol'],
    spec: [['Alice,Bob,Carol', 4], ['Bob,Alice,Carol', 3], ['Carol,Bob,Alice', 2]],
  });
  const text = renderedText(report.bytes);

  assert.match(text, /Round-by-round count/);
  assert.match(text, /Round 1/);
  assert.match(text, /Round 2/);
  assert.match(text, /Excl\./, 'the excluded candidate is marked');
  assert.match(text, /Votes needed for more than 50%/);
  assert.match(text, /Ballots exhausted/);
  assert.match(text, /Carol was lowest on 2 vote\(s\) and was excluded/);
});

test('a tie produces a referral report that names no winner', () => {
  const { result, report } = buildFor({ names: ['Alice', 'Bob'], spec: [['Alice,Bob', 5], ['Bob,Alice', 5]] });
  const text = renderedText(report.bytes);

  assert.equal(result.outcome.status, OUTCOME_REFERRAL);
  assert.match(text, /RESULT: NO CANDIDATE ELECTED BY THIS COUNT/);
  assert.doesNotMatch(text, /RESULT: CANDIDATE ELECTED/);
  assert.match(text, /appointed vote of the Committee/, 's 2.05(j) instruction must be printed');
  assert.match(text, /does not and may not break a tie/);
});

test('an appointed-position referral prints the s 1.09(g) casting vote instruction', () => {
  const { report } = buildFor({
    names: ['Alice', 'Bob'],
    spec: [['Alice,Bob', 2], ['Bob,Alice', 2]],
    positionTitle: 'Webmaster',
    electionTypeId: 'appointed',
  });
  const text = renderedText(report.bytes);

  assert.match(text, /casting vote/);
  assert.match(text, /s 2\.03/);
});

test('the reconciliation, flagged ballots and full ledger are all printed', () => {
  const { report } = buildFor({
    names: ['Alice', 'Bob', 'Carol'],
    spec: [['Alice,Bob,Carol', 5], ['Bob,Alice,Carol', 2]],
    extraBallots: [
      { serial: 8, marks: { alice: '1', carol: '3' } }, // skipped number
      { serial: 9, marks: { alice: '2', bob: '3' } }, // no first preference -> informal
      { serial: 10, marks: {} }, // blank
      { serial: 11, marks: { bob: '1' }, voided: true },
    ],
  });
  const text = renderedText(report.bytes);

  assert.match(text, /Ballot reconciliation/);
  assert.match(text, /Entries in the ballot ledger/);
  assert.match(text, /INFORMAL/);
  assert.match(text, /VOIDED/);
  assert.match(text, /Complete ballot ledger/);
  assert.match(text, /Ballots requiring the Returning Officer's attention/);
  assert.match(flatText(report.bytes), /preference number was skipped/i);
  assert.match(text, /1=Alice/, 'marks are printed as transcribed');
  assert.match(text, /\(blank\)/);
});

test('the arithmetic checks are printed and pass', () => {
  const { result, report } = buildFor({
    names: ['Alice', 'Bob', 'Carol', 'Dave'],
    spec: [['Alice,Bob', 6], ['Bob,Carol', 5], ['Carol,Alice', 3], ['Dave,Alice', 2]],
  });
  const text = renderedText(report.bytes);

  assert.match(text, /Arithmetic checks/);
  assert.ok(result.checks.every((check) => check.pass), 'the sample count must reconcile');
  assert.doesNotMatch(text, /FAIL/);
  assert.match(text, /PASS/);
});

test('an exhausted-ballot majority is disclosed explicitly', () => {
  const { result, report } = buildFor({
    names: ['Alice', 'Bob', 'Carol'],
    spec: [['Alice', 4], ['Bob', 3], ['Carol', 3]],
  });
  const text = renderedText(report.bytes);

  assert.equal(result.outcome.status, OUTCOME_ELECTED);
  assert.match(text, /Basis of the majority/);
  assert.match(text, /DISCLOSURE/);
  assert.match(text, /not of all 10 formal ballots cast/);
});

test('an empty ledger yields a report that declares nobody', () => {
  const candidates = candidatesFrom('Alice', 'Bob');
  const result = runCount({ candidates, ballots: [] });
  const report = buildCountReport({ result, positionTitle: 'President', ballots: [], generatedAt: FIXED_TIME });
  const text = renderedText(report.bytes);

  assert.match(text, /RESULT: NO COUNT POSSIBLE/);
  assert.match(text, /ballot ledger is empty/i);
  assert.doesNotMatch(text, /RESULT: CANDIDATE ELECTED/);
});

test('the file name is safe and identifies the position', () => {
  const { report } = buildFor({
    names: ['Alice', 'Bob'],
    spec: [['Alice,Bob', 3], ['Bob,Alice', 1]],
    positionTitle: 'Vice-President (Internal) / Social',
  });

  assert.match(report.fileName, /^uec-count-vice-president-internal-social-\d{8}\d{4}\.pdf$/);
  assert.doesNotMatch(report.fileName, /[\\/:*?"<>|]/);
});

/* ---------------------------------------------------------------- *
 * Text layout primitives
 * ---------------------------------------------------------------- */

test('non-WinAnsi characters are transliterated rather than lost', () => {
  assert.equal(toWinAnsi('“quoted” — dash…'), '"quoted" -- dash...');
  assert.equal(toWinAnsi('Engineers’ Club'), "Engineers' Club");
  assert.equal(toWinAnsi('José Muñoz'), 'José Muñoz', 'Latin-1 accents survive');
  assert.equal(toWinAnsi('Ω☃'), '??', 'anything unrenderable becomes a visible placeholder');
});

test('wrapped lines never exceed the column width', () => {
  const width = 120;
  const lines = wrapText(
    'The Returning Officer shall count the ballot cards in accordance with a conventional preferential voting system.',
    width,
    9.5,
  );

  assert.ok(lines.length > 1);
  lines.forEach((line) => {
    assert.ok(measureText(line, 9.5) <= width, `"${line}" overflows the column`);
  });
});

test('an unbreakable token is split instead of overflowing', () => {
  const digest = 'a'.repeat(64);
  const lines = wrapText(digest, 80, 9);

  assert.ok(lines.length > 1);
  assert.equal(lines.join(''), digest, 'no characters may be dropped');
  lines.forEach((line) => {
    assert.ok(measureText(line, 9) <= 80);
  });
});

/* ---------------------------------------------------------------- *
 * Artefact for manual inspection
 * ---------------------------------------------------------------- */

test('writes a sample report for manual inspection', () => {
  const { report } = buildFor({
    names: ['Alice Nguyen', 'Bob Smith', 'Carol Jones', 'Dave Patel'],
    spec: [['Alice Nguyen,Bob Smith', 9], ['Bob Smith,Carol Jones', 7], ['Carol Jones,Dave Patel,Alice Nguyen', 5], ['Dave Patel,Alice Nguyen', 3]],
    extraBallots: [
      { serial: 25, marks: { 'alice nguyen': '1', 'carol jones': '3' } },
      { serial: 26, marks: {} },
    ],
  });

  const directory = join(tmpdir(), 'easy-vote-report-samples');
  mkdirSync(directory, { recursive: true });
  const target = join(directory, 'sample-count-report.pdf');
  writeFileSync(target, report.bytes);
  writeFileSync(join(directory, 'sample-ballot-record.txt'), report.record, 'utf8');

  assert.ok(report.bytes.length > 4000, 'a real report should not be trivially small');
});
