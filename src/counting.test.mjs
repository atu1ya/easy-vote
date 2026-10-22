/**
 * Tests for the UEC count engine. Run with:  npm test
 *
 * These exist so that the counting rules can be checked against the
 * Constitution by inspection, independently of the user interface.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BALLOT_FORMAL,
  BALLOT_INFORMAL,
  BALLOT_VOIDED,
  OUTCOME_ELECTED,
  OUTCOME_NO_BALLOTS,
  OUTCOME_REFERRAL,
  canonicalRecord,
  classifyBallot,
  digestRecord,
  majorityDisclosure,
  runCount,
  sha256Hex,
} from './counting.js';

/* ---------------------------------------------------------------- *
 * Helpers
 * ---------------------------------------------------------------- */

const candidatesFrom = (...names) => names.map((name) => ({ id: name.toLowerCase(), name }));

/** `ballot('A,B,C')` ranks A first, B second, C third. */
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

/** Build ballots from a compact spec: `['A,B', 3]` means 3 ballots of A then B. */
const ballotsFrom = (spec) => {
  const result = [];
  spec.forEach(([order, count]) => {
    for (let index = 0; index < count; index += 1) {
      result.push(ballot(result.length + 1, order));
    }
  });
  return result;
};

const count = (names, spec, electionTypeId = 'elected') =>
  runCount({ candidates: candidatesFrom(...names), ballots: ballotsFrom(spec), electionTypeId });

const assertChecksPass = (result) => {
  const failed = result.checks.filter((check) => !check.pass);
  assert.deepEqual(
    failed.map((check) => `${check.label}: ${check.detail}`),
    [],
    'all arithmetic self-checks must pass',
  );
};

/* ---------------------------------------------------------------- *
 * s 2.05(i) — majority on first preferences
 * ---------------------------------------------------------------- */

test('declares a winner who holds more than 50% of first preferences in round 1', () => {
  const result = count(['A', 'B', 'C'], [['A,B,C', 6], ['B,A,C', 3], ['C,A,B', 2]]);

  assert.equal(result.outcome.status, OUTCOME_ELECTED);
  assert.equal(result.outcome.winnerId, 'a');
  assert.equal(result.rounds.length, 1, 'no exclusions are needed once a majority exists');
  assert.equal(result.rounds[0].outcome, 'majority-reached');
  assert.equal(result.rounds[0].majorityThreshold, 6, '11 ballots require 6 to exceed 50%');
  assertChecksPass(result);
});

test('exactly 50% is not a majority and does not win on the spot', () => {
  // 5 of 10 first preferences for A: "more than 50%" is not met (s 2.05(i)).
  const result = count(['A', 'B', 'C'], [['A,B,C', 5], ['B,C,A', 3], ['C,B,A', 2]]);

  assert.equal(result.rounds[0].majorityThreshold, 6);
  assert.notEqual(result.rounds[0].outcome, 'majority-reached');
  // C is excluded, its 2 ballots flow to B, giving B 5 and A 5 — a tie.
  assert.equal(result.outcome.status, OUTCOME_REFERRAL);
});

test('distributes preferences on exclusion until a majority appears', () => {
  const result = count(['A', 'B', 'C'], [['A,B,C', 4], ['B,A,C', 3], ['C,B,A', 2]]);

  // Round 1: A 4, B 3, C 2 of 9 (threshold 5). C excluded, its 2 flow to B.
  // Round 2: B 5, A 4 — B elected.
  assert.equal(result.outcome.status, OUTCOME_ELECTED);
  assert.equal(result.outcome.winnerId, 'b');
  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[0].excludedId, 'c');
  assert.deepEqual(result.rounds[1].counts, { a: 4, b: 5 });
  assertChecksPass(result);
});

/* ---------------------------------------------------------------- *
 * s 2.05(j) — the engine must never break a tie
 * ---------------------------------------------------------------- */

test('a two-candidate dead heat is referred, not broken', () => {
  const result = count(['A', 'B'], [['A,B', 5], ['B,A', 5]]);

  assert.equal(result.outcome.status, OUTCOME_REFERRAL);
  assert.equal(result.outcome.winnerId, null);
  assert.equal(result.outcome.reason, 'tie-for-election');
  assert.deepEqual(result.outcome.candidateIds, ['a', 'b']);
  assert.equal(result.outcome.authority, 's 2.05(j)');
  assert.match(result.outcome.instruction, /appointed vote of the Committee/);
});

test('a tie for exclusion that changes the winner is referred', () => {
  // Round 1: A 4, B 3, C 3 of 10 (threshold 6).
  // Exclude B -> its ballots go to C, C wins. Exclude C -> its ballots go to B,
  // B wins. The choice decides the election, so it must go to the Committee.
  const result = count(['A', 'B', 'C'], [['A,B,C', 4], ['B,C,A', 3], ['C,B,A', 3]]);

  assert.equal(result.outcome.status, OUTCOME_REFERRAL);
  assert.equal(result.outcome.reason, 'tie-for-exclusion');
  assert.deepEqual(result.outcome.candidateIds, ['b', 'c']);
});

test('the tie candidates reported are only those who stood in this election', () => {
  // s 2.05(j): only original candidates may be considered in the appointed vote.
  const result = count(['A', 'B'], [['A,B', 2], ['B,A', 2]]);
  const standing = new Set(result.candidates.map((candidate) => candidate.id));

  result.outcome.candidateIds.forEach((candidateId) => {
    assert.ok(standing.has(candidateId), `${candidateId} must be an original candidate`);
  });
});

test('an appointed-position tie cites s 1.09(g) and the casting vote', () => {
  const result = count(['A', 'B'], [['A,B', 3], ['B,A', 3]], 'appointed');

  assert.equal(result.outcome.status, OUTCOME_REFERRAL);
  assert.equal(result.outcome.authority, 's 2.03(b) / s 1.09(g)');
  assert.match(result.outcome.instruction, /casting vote/);
});

/* ---------------------------------------------------------------- *
 * Immaterial ties proceed, with disclosure
 * ---------------------------------------------------------------- */

test('a tie for exclusion that cannot change the winner does not stop the count', () => {
  // Round 1: A 5, B 3, C 1, D 1 of 10 (threshold 6). C and D are tied last, but
  // both their ballots prefer A next, so A is elected either way.
  const result = count(
    ['A', 'B', 'C', 'D'],
    [['A,B,C,D', 5], ['B,A,C,D', 3], ['C,A,B,D', 1], ['D,A,B,C', 1]],
  );

  assert.equal(result.outcome.status, OUTCOME_ELECTED);
  assert.equal(result.outcome.winnerId, 'a');
  assert.equal(result.tieEvents.length, 1, 'the tie is recorded even though it was immaterial');
  assert.deepEqual(result.tieEvents[0].candidateIds, ['c', 'd']);
  result.tieEvents[0].branchOutcomes.forEach((branch) => {
    assert.deepEqual(branch.winnerIds, ['a'], 'every exclusion order elects the same candidate');
  });
  assertChecksPass(result);
});

test('the declared winner is the same whatever order the candidates were entered in', () => {
  const spec = [['A,B,C,D', 5], ['B,A,C,D', 3], ['C,A,B,D', 1], ['D,A,B,C', 1]];
  const orders = [
    ['A', 'B', 'C', 'D'],
    ['D', 'C', 'B', 'A'],
    ['C', 'A', 'D', 'B'],
    ['B', 'D', 'A', 'C'],
  ];

  orders.forEach((order) => {
    const result = count(order, spec);
    assert.equal(result.outcome.status, OUTCOME_ELECTED);
    assert.equal(result.outcome.winnerId, 'a', `entry order ${order.join('')} must not change the result`);
  });
});

/* ---------------------------------------------------------------- *
 * Exhausted ballots
 * ---------------------------------------------------------------- */

test('exhausted ballots leave the count and are reported', () => {
  // 3 ballots mark only C. When C is excluded they exhaust.
  const result = count(['A', 'B', 'C'], [['A', 4], ['B', 3], ['C', 3]]);

  assert.equal(result.rounds[0].exhaustedBallots, 0);
  assert.equal(result.rounds[0].excludedId, 'b');

  const finalRound = result.rounds[result.rounds.length - 1];
  assert.equal(result.outcome.status, OUTCOME_ELECTED);
  assert.equal(result.outcome.winnerId, 'a');
  assert.equal(finalRound.exhaustedBallots, 3, 'the three C-only ballots exhaust');
  assert.equal(finalRound.continuingBallots, 7);
  assertChecksPass(result);
});

test('discloses when a winner lacks a majority of all formal ballots', () => {
  const result = count(['A', 'B', 'C'], [['A', 4], ['B', 3], ['C', 3]]);
  const disclosure = majorityDisclosure(result);

  assert.equal(disclosure.totalFormal, 10);
  assert.equal(disclosure.winnerVotes, 4);
  assert.equal(disclosure.majorityOfContinuing, true, 'wins on the conventional continuing-ballot test');
  assert.equal(disclosure.majorityOfAllFormal, false, '4 of 10 is not a majority of all ballots cast');
  assert.equal(disclosure.divergent, true, 'the divergence must be surfaced, not hidden');
});

test('a count where every ballot exhausts is referred rather than declared', () => {
  // Both ballots mark only C. Once C is excluded nothing remains to count.
  const result = count(['A', 'B', 'C'], [['C', 2]]);

  // C holds 2 of 2 and is elected outright here.
  assert.equal(result.outcome.winnerId, 'c');

  // But if the plumping is split so nobody reaches a majority and all ballots
  // exhaust, no winner may be declared.
  const exhausting = count(['A', 'B', 'C'], [['C', 1], ['A', 1], ['B', 1]]);
  assert.equal(exhausting.outcome.status, OUTCOME_REFERRAL);
});

/* ---------------------------------------------------------------- *
 * Refusal to declare without ballots
 * ---------------------------------------------------------------- */

test('an empty ledger declares nobody', () => {
  const result = runCount({ candidates: candidatesFrom('A', 'B'), ballots: [] });

  assert.equal(result.outcome.status, OUTCOME_NO_BALLOTS);
  assert.equal(result.outcome.winnerId, null);
  assert.equal(result.rounds.length, 0);
});

test('a ledger of only informal ballots declares nobody', () => {
  const result = runCount({
    candidates: candidatesFrom('A', 'B'),
    ballots: [
      { serial: 1, marks: {} },
      { serial: 2, marks: { a: '1' }, informal: true },
    ],
  });

  assert.equal(result.outcome.status, OUTCOME_NO_BALLOTS);
  assert.equal(result.reconciliation.informal, 2);
  assert.equal(result.reconciliation.formal, 0);
});

test('fewer than two candidates cannot be counted', () => {
  const result = runCount({ candidates: candidatesFrom('A'), ballots: [ballot(1, 'A')] });

  assert.equal(result.outcome.status, OUTCOME_NO_BALLOTS);
  assert.equal(result.outcome.winnerId, null);
});

/* ---------------------------------------------------------------- *
 * Ballot classification
 * ---------------------------------------------------------------- */

const three = candidatesFrom('A', 'B', 'C');

test('a fully numbered ballot is formal with no flags', () => {
  const classified = classifyBallot({ serial: 1, marks: { a: '1', b: '2', c: '3' } }, three);

  assert.equal(classified.status, BALLOT_FORMAL);
  assert.deepEqual(classified.preferences, ['a', 'b', 'c']);
  assert.deepEqual(classified.flags, []);
  assert.equal(classified.requiresReview, false);
});

test('a partially numbered ballot is formal and is not flagged', () => {
  const classified = classifyBallot({ serial: 1, marks: { b: '1' } }, three);

  assert.equal(classified.status, BALLOT_FORMAL);
  assert.deepEqual(classified.preferences, ['b']);
  assert.deepEqual(classified.flags, []);
});

test('a skipped number truncates the ballot and is flagged', () => {
  const classified = classifyBallot({ serial: 7, marks: { a: '1', c: '3' } }, three);

  assert.equal(classified.status, BALLOT_FORMAL);
  assert.deepEqual(classified.preferences, ['a'], 'counting stops at the gap');
  assert.ok(classified.flags.includes('skipped-number'));
  assert.ok(classified.flags.includes('marks-not-counted'));
  assert.equal(classified.requiresReview, true);
});

test('a repeated number truncates the ballot and is flagged', () => {
  const classified = classifyBallot({ serial: 8, marks: { a: '1', b: '2', c: '2' } }, three);

  assert.equal(classified.status, BALLOT_FORMAL);
  assert.deepEqual(classified.preferences, ['a']);
  assert.ok(classified.flags.includes('repeated-number'));
  assert.equal(classified.requiresReview, true);
});

test('a ballot with no first preference is informal', () => {
  const classified = classifyBallot({ serial: 9, marks: { a: '2', b: '3' } }, three);

  assert.equal(classified.status, BALLOT_INFORMAL);
  assert.deepEqual(classified.preferences, []);
  assert.ok(classified.flags.includes('no-first-preference'));
  assert.equal(classified.requiresReview, true);
});

test('a duplicated first preference is informal', () => {
  const classified = classifyBallot({ serial: 10, marks: { a: '1', b: '1' } }, three);

  assert.equal(classified.status, BALLOT_INFORMAL);
  assert.ok(classified.flags.includes('repeated-number'));
});

test('a blank ballot is informal and needs no review', () => {
  const classified = classifyBallot({ serial: 11, marks: { a: '', b: '  ' } }, three);

  assert.equal(classified.status, BALLOT_INFORMAL);
  assert.ok(classified.flags.includes('no-marks'));
  assert.equal(classified.requiresReview, false);
});

test('a number above the candidate count is flagged', () => {
  const classified = classifyBallot({ serial: 12, marks: { a: '1', b: '9' } }, three);

  assert.ok(classified.flags.includes('number-out-of-range'));
  assert.equal(classified.requiresReview, true);
});

test('marks against unknown candidates are ignored', () => {
  const classified = classifyBallot({ serial: 13, marks: { a: '1', zz: '2' } }, three);

  assert.deepEqual(classified.preferences, ['a']);
  assert.equal(classified.marks.zz, undefined);
});

test('a voided entry is excluded from every total', () => {
  const result = runCount({
    candidates: three,
    ballots: [ballot(1, 'A,B,C'), ballot(2, 'B,A,C'), { ...ballot(3, 'B,A,C'), voided: true }],
  });

  assert.equal(result.classifiedBallots[2].status, BALLOT_VOIDED);
  assert.equal(result.reconciliation.entriesInLedger, 3);
  assert.equal(result.reconciliation.voided, 1);
  assert.equal(result.reconciliation.ballotsAdmitted, 2);
  assert.equal(result.reconciliation.formal, 2);
});

test('an informal ballot takes no part in the count but stays in the ledger', () => {
  const result = runCount({
    candidates: three,
    ballots: [ballot(1, 'A,B,C'), ballot(2, 'A,B,C'), { serial: 3, marks: { b: '2' } }],
  });

  assert.equal(result.reconciliation.formal, 2);
  assert.equal(result.reconciliation.informal, 1);
  assert.equal(result.rounds[0].counts.a, 2);
  assert.equal(result.outcome.winnerId, 'a');
  assertChecksPass(result);
});

/* ---------------------------------------------------------------- *
 * Determinism, reconciliation, and the audit record
 * ---------------------------------------------------------------- */

test('the same ledger always produces the same report', () => {
  const build = () =>
    runCount({
      candidates: candidatesFrom('A', 'B', 'C', 'D'),
      ballots: ballotsFrom([['A,B,C,D', 3], ['B,C,A,D', 4], ['C,D,A,B', 2], ['D,A,B,C', 2]]),
    });

  const first = build();
  const second = build();

  assert.equal(first.outcome.status, second.outcome.status);
  assert.equal(first.outcome.winnerId, second.outcome.winnerId);
  assert.deepEqual(
    first.rounds.map((round) => [round.roundNumber, round.counts, round.excludedId]),
    second.rounds.map((round) => [round.roundNumber, round.counts, round.excludedId]),
  );
});

test('every round accounts for every formal ballot', () => {
  const result = count(
    ['A', 'B', 'C', 'D'],
    [['A,B', 4], ['B,C', 3], ['C', 2], ['D,A', 2]],
  );

  result.rounds.forEach((round) => {
    const summed = Object.values(round.counts).reduce((total, value) => total + value, 0);
    assert.equal(
      summed + round.exhaustedBallots,
      result.reconciliation.formal,
      `round ${round.roundNumber} must account for all ${result.reconciliation.formal} formal ballots`,
    );
  });
  assertChecksPass(result);
});

test('the canonical record is stable and independent of ledger order', () => {
  const candidates = candidatesFrom('A', 'B');
  const inOrder = [ballot(1, 'A,B'), ballot(2, 'B,A')];
  const reversed = [ballot(2, 'B,A'), ballot(1, 'A,B')];
  const payload = { positionTitle: 'President', electionTypeId: 'elected', candidates };

  assert.equal(
    canonicalRecord({ ...payload, ballots: inOrder }),
    canonicalRecord({ ...payload, ballots: reversed }),
  );
});

test('the canonical record changes when any mark changes', () => {
  const candidates = candidatesFrom('A', 'B');
  const payload = { positionTitle: 'President', electionTypeId: 'elected', candidates };

  const before = canonicalRecord({ ...payload, ballots: [ballot(1, 'A,B')] });
  const after = canonicalRecord({ ...payload, ballots: [ballot(1, 'B,A')] });

  assert.notEqual(before, after);
  assert.notEqual(digestRecord(before).hex, digestRecord(after).hex);
});

test('the digest matches a standard SHA-256 implementation', () => {
  const samples = [
    '',
    'abc',
    'The University Engineers’ Club',
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(57),
    'x'.repeat(64),
    'x'.repeat(1000),
    canonicalRecord({
      positionTitle: 'President',
      electionTypeId: 'elected',
      candidates: candidatesFrom('A', 'B', 'C'),
      ballots: ballotsFrom([['A,B,C', 2], ['B,C,A', 1]]),
    }),
  ];

  samples.forEach((sample) => {
    assert.equal(
      sha256Hex(sample),
      createHash('sha256').update(sample, 'utf8').digest('hex'),
      `digest mismatch for a ${sample.length}-character input`,
    );
  });
});

/* ---------------------------------------------------------------- *
 * Robustness
 * ---------------------------------------------------------------- */

test('a large field with many ties still terminates and never guesses', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const ballots = names.map((name, index) => ballot(index + 1, name));
  const result = runCount({ candidates: candidatesFrom(...names), ballots });

  // Eight candidates on one plumped vote each: a complete dead heat.
  assert.equal(result.outcome.status, OUTCOME_REFERRAL);
  assert.equal(result.outcome.winnerId, null);
});

test('a winner is still found when early rounds contain immaterial ties', () => {
  const result = count(
    ['A', 'B', 'C', 'D', 'E'],
    [['A,B,C,D,E', 6], ['B,A,C,D,E', 4], ['C,A,B,D,E', 1], ['D,A,B,C,E', 1], ['E,A,B,C,D', 1]],
  );

  assert.equal(result.outcome.status, OUTCOME_ELECTED);
  assert.equal(result.outcome.winnerId, 'a');
  assertChecksPass(result);
});
