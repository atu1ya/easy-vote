/**
 * UEC preferential count engine.
 *
 * This module is pure (no DOM, no React, no I/O) so that it can be unit tested
 * and independently re-executed by a scrutineer against the exported ballot
 * ledger.
 *
 * GOVERNING RULES — The University Engineers' Club Constitution (7 August 2026)
 *
 *   s 2.05(i)  "Ballots shall call for candidates to be ranked in order of the
 *              voter's preference. When counting, the returning officer should
 *              count votes according to a conventional preferential voting
 *              system and announce a winner when one candidate has received
 *              more than 50% of the 1st preference votes."
 *
 *   s 2.05(j)  "Where a preferential count results in a tie between candidates
 *              for an Elected position, the tied candidates shall be put to an
 *              appointed vote of the Committee to determine the successful
 *              candidate. Only persons who ran as candidates in the original
 *              election for that position may be considered in the appointed
 *              vote."
 *
 *   s 2.03(a)  Appointed Positions are filled by preferential ballot of the
 *              Elected Committee Members, supervised by the Secretary as
 *              Returning Officer.
 *   s 2.03(b)  A tie in a s 2.03(a) ballot is resolved under s 1.09(g).
 *   s 1.09(g)  "...questions at Committee Meetings must be decided by a
 *              majority of votes, however if there is no majority, the person
 *              presiding over the meeting will have a casting vote in addition
 *              to their deliberative vote."
 *
 * DESIGN CONSEQUENCES
 *
 *   1. This engine NEVER breaks a tie. The Constitution assigns tie resolution
 *      to humans (the Committee under s 2.05(j), or the chair's casting vote
 *      under s 1.09(g) / s 2.03(b)). Any tie that could change who is elected
 *      halts the count and is reported as a referral.
 *
 *   2. Ties that cannot change the result are not referred. Instead of guessing
 *      which tied candidate to exclude, the engine exhaustively explores EVERY
 *      lawful exclusion order. If all of them elect the same candidate, the tie
 *      is immaterial and the result is certain. If any two differ, or any
 *      branch fails to produce a winner, the count halts for referral.
 *      Exhaustive exploration is sound where a single guess is not.
 *
 *   3. Nothing is silently reinterpreted. Every ballot deviation (skipped
 *      number, repeated number, out-of-range number, marks after a break) is
 *      itemised against the ballot's serial number for the Returning Officer
 *      to adjudicate.
 *
 *   4. The engine is deterministic and a pure function of (candidates,
 *      ballots). The same ledger always produces the same report, so a second
 *      counter can reproduce it exactly.
 */

export const RULES_VERSION = 'UEC-Constitution-2026-08-07';
export const ENGINE_VERSION = '2.0.0';

/** Upper bound on explored exclusion states. Exceeding it halts for referral. */
export const MAX_EXPLORED_STATES = 50000;

/* ------------------------------------------------------------------ *
 * Election types
 * ------------------------------------------------------------------ */

export const ELECTION_TYPES = {
  elected: {
    id: 'elected',
    label: 'Elected position (General Election)',
    countAuthority: 's 2.05(i)',
    tieAuthority: 's 2.05(j)',
    tieInstruction:
      'The tied candidates must be put to an appointed vote of the Committee to determine the successful candidate. Only persons who ran as candidates in the original election for this position may be considered in that appointed vote (s 2.05(j)).',
    scrutinyNote:
      'General Elections must be supervised by, and the ballot cards counted by, at least one appointed Returning Officer who may not be a Member of the Club (s 2.05(c)).',
  },
  appointed: {
    id: 'appointed',
    label: 'Appointed position (Committee ballot)',
    countAuthority: 's 2.03(a)',
    tieAuthority: 's 2.03(b) / s 1.09(g)',
    tieInstruction:
      'The tie is resolved under s 1.09(g): the question is decided by a majority of votes of the Committee, and if there is no majority the person presiding over the meeting exercises a casting vote in addition to their deliberative vote (s 2.03(b)).',
    scrutinyNote:
      'The ballot is taken of the Elected Committee Members and supervised by the Secretary as Returning Officer. A Committee Member may vote only for positions for which they are eligible to nominate (s 2.03(a), s 2.06).',
  },
};

export const DEFAULT_ELECTION_TYPE = 'elected';

export const getElectionType = (id) => ELECTION_TYPES[id] ?? ELECTION_TYPES[DEFAULT_ELECTION_TYPE];

/* ------------------------------------------------------------------ *
 * Ballot classification
 * ------------------------------------------------------------------ */

export const BALLOT_FORMAL = 'formal';
export const BALLOT_INFORMAL = 'informal';
export const BALLOT_VOIDED = 'voided';

/**
 * Human-readable explanation of every flag this module can raise, so the
 * printed report can explain itself without reference to the source.
 */
export const FLAG_DESCRIPTIONS = {
  'no-marks': 'No preference numbers were recorded on the slip.',
  'no-first-preference': 'No candidate was marked with the number 1, so no first preference can be determined.',
  'repeated-number': 'The same preference number was written against more than one candidate. The count stops at that number.',
  'skipped-number': 'A preference number was skipped. The count stops at the gap.',
  'number-out-of-range': 'A preference number higher than the number of candidates was recorded.',
  'marks-not-counted': 'Marks after the first break in numbering were recorded but not counted.',
  'marked-informal': 'The Returning Officer recorded this slip as informal.',
  'voided': 'This entry was voided by the Returning Officer and is excluded from all totals.',
};

/**
 * Classify one ballot as transcribed from the paper slip.
 *
 * Counting rule (conventional preferential practice, s 2.05(i)):
 *   - The counted preference sequence is taken from number 1 upwards.
 *   - It stops immediately before the first number that is missing or that was
 *     used against more than one candidate.
 *   - A slip with no clear first preference is informal.
 *   - Marks beyond the stopping point are preserved in the ledger but not
 *     counted, and are flagged.
 *
 * @param {{serial:number, marks:Object<string,string>, informal?:boolean, voided?:boolean, note?:string}} ballot
 * @param {Array<{id:string,name:string}>} candidates
 */
export const classifyBallot = (ballot, candidates) => {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const flags = [];

  if (ballot.voided) {
    return {
      serial: ballot.serial,
      status: BALLOT_VOIDED,
      preferences: [],
      flags: ['voided'],
      requiresReview: false,
      marks: {},
    };
  }

  /** rank number -> candidate ids carrying that number */
  const byRank = new Map();
  const marks = {};

  Object.entries(ballot.marks ?? {}).forEach(([candidateId, rawValue]) => {
    if (!candidateIds.has(candidateId)) {
      return;
    }

    const text = String(rawValue ?? '').trim();
    if (text === '') {
      return;
    }

    if (!/^\d+$/.test(text)) {
      // The entry field only admits digits; this is a defence in depth.
      return;
    }

    const rank = Number.parseInt(text, 10);
    if (!Number.isSafeInteger(rank) || rank < 1) {
      return;
    }

    marks[candidateId] = rank;

    if (rank > candidates.length) {
      flags.push('number-out-of-range');
    }

    if (!byRank.has(rank)) {
      byRank.set(rank, []);
    }
    byRank.get(rank).push(candidateId);
  });

  const markCount = Object.keys(marks).length;

  if (markCount === 0) {
    return {
      serial: ballot.serial,
      status: BALLOT_INFORMAL,
      preferences: [],
      flags: ballot.informal ? ['marked-informal'] : ['no-marks'],
      requiresReview: false,
      marks,
    };
  }

  if (ballot.informal) {
    return {
      serial: ballot.serial,
      status: BALLOT_INFORMAL,
      preferences: [],
      flags: ['marked-informal'],
      requiresReview: false,
      marks,
    };
  }

  // Walk 1, 2, 3, ... and stop at the first break.
  const preferences = [];
  let stoppedBecause = null;

  for (let rank = 1; rank <= candidates.length; rank += 1) {
    const holders = byRank.get(rank);

    if (!holders) {
      stoppedBecause = 'skipped-number';
      break;
    }

    if (holders.length > 1) {
      stoppedBecause = 'repeated-number';
      break;
    }

    preferences.push(holders[0]);
  }

  // A slip numbered 1..k and then left blank is a lawful partial vote, not a
  // defect, so a stop is only flagged when it left recorded marks uncounted.
  if (stoppedBecause && preferences.length < markCount) {
    flags.push(stoppedBecause);
  }

  if (preferences.length < markCount) {
    flags.push('marks-not-counted');
  }

  if (preferences.length === 0) {
    return {
      serial: ballot.serial,
      status: BALLOT_INFORMAL,
      preferences: [],
      flags: dedupe([...flags, 'no-first-preference']),
      requiresReview: true,
      marks,
    };
  }

  const uniqueFlags = dedupe(flags);

  return {
    serial: ballot.serial,
    status: BALLOT_FORMAL,
    preferences,
    flags: uniqueFlags,
    requiresReview: uniqueFlags.length > 0,
    marks,
  };
};

const dedupe = (values) => [...new Set(values)];

/* ------------------------------------------------------------------ *
 * Round counting
 * ------------------------------------------------------------------ */

/**
 * Count one round: each formal ballot gives one vote to its most preferred
 * candidate who is still continuing. Ballots with no continuing preference are
 * exhausted and leave the denominator, per conventional preferential practice.
 */
const countRound = (continuingIds, preferenceLists) => {
  const continuing = new Set(continuingIds);
  const counts = Object.fromEntries(continuingIds.map((id) => [id, 0]));
  const exhaustedSerials = [];
  let continuingBallots = 0;

  preferenceLists.forEach((entry) => {
    const topChoice = entry.preferences.find((candidateId) => continuing.has(candidateId));

    if (topChoice === undefined) {
      exhaustedSerials.push(entry.serial);
      return;
    }

    counts[topChoice] += 1;
    continuingBallots += 1;
  });

  // "more than 50%" (s 2.05(i)) — strictly greater than half, never equal.
  const majorityThreshold = Math.floor(continuingBallots / 2) + 1;

  return {
    counts,
    continuingBallots,
    exhaustedBallots: exhaustedSerials.length,
    exhaustedSerials,
    majorityThreshold,
  };
};

/* ------------------------------------------------------------------ *
 * Exhaustive exclusion-order exploration
 * ------------------------------------------------------------------ */

export const BLOCK_REASONS = {
  'tie-for-exclusion': 'Two or more candidates are equally lowest and the choice of which to exclude changes who is elected.',
  'tie-for-election': 'Candidates are tied and no candidate can reach more than 50% of the votes.',
  'no-support': 'No continuing candidate holds any vote, so no candidate can be elected on these ballots.',
  'complexity-limit': 'The number of lawful exclusion orders exceeded the engine limit, so certainty could not be established.',
};

/**
 * Explore every lawful exclusion order from a given continuing set.
 *
 * Returns either the set of candidates who could be elected, or a block,
 * meaning no determinate winner exists without a human decision.
 *
 * Memoised on the continuing set: the outcome depends only on which candidates
 * are still continuing (the ballots are fixed), so memoisation is exact.
 *
 * @returns {{winnerIds:string[]|null, block:{reason:string, candidateIds:string[]}|null}}
 */
const buildExplorer = (orderedCandidateIds, preferenceLists) => {
  const memo = new Map();
  const state = { visited: 0, limitHit: false };

  const explore = (continuingIds) => {
    const cacheKey = continuingIds.join('|');
    if (memo.has(cacheKey)) {
      return memo.get(cacheKey);
    }

    if (state.visited >= MAX_EXPLORED_STATES) {
      state.limitHit = true;
      return { winnerIds: null, block: { reason: 'complexity-limit', candidateIds: [...continuingIds] } };
    }
    state.visited += 1;

    const round = countRound(continuingIds, preferenceLists);

    const majorityWinner = continuingIds.find((id) => round.counts[id] >= round.majorityThreshold);
    if (majorityWinner !== undefined && round.continuingBallots > 0) {
      const result = { winnerIds: [majorityWinner], block: null };
      memo.set(cacheKey, result);
      return result;
    }

    if (round.continuingBallots === 0) {
      // Every ballot is exhausted; nobody can be elected on these papers.
      const result = {
        winnerIds: null,
        block: { reason: 'no-support', candidateIds: [...continuingIds] },
      };
      memo.set(cacheKey, result);
      return result;
    }

    if (continuingIds.length === 1) {
      // Last candidate standing with at least one vote.
      const result = { winnerIds: [continuingIds[0]], block: null };
      memo.set(cacheKey, result);
      return result;
    }

    const lowestCount = Math.min(...continuingIds.map((id) => round.counts[id]));
    const lowestIds = continuingIds.filter((id) => round.counts[id] === lowestCount);

    if (lowestIds.length === continuingIds.length) {
      // Everyone is level and nobody has a majority: excluding any candidate is
      // an arbitrary choice between equals. This is the tie s 2.05(j) /
      // s 1.09(g) reserves to humans.
      const result = {
        winnerIds: null,
        block: { reason: 'tie-for-election', candidateIds: [...continuingIds] },
      };
      memo.set(cacheKey, result);
      return result;
    }

    const winners = new Set();
    let block = null;

    for (const excludedId of lowestIds) {
      const sub = explore(continuingIds.filter((id) => id !== excludedId));

      if (sub.block) {
        block = sub.block;
        break;
      }

      sub.winnerIds.forEach((id) => winners.add(id));

      if (winners.size > 1) {
        // Different lawful exclusion orders elect different candidates, so the
        // tie is material and must be referred.
        block = { reason: 'tie-for-exclusion', candidateIds: [...lowestIds] };
        break;
      }
    }

    const result = block
      ? { winnerIds: null, block }
      : { winnerIds: orderedCandidateIds.filter((id) => winners.has(id)), block: null };

    memo.set(cacheKey, result);
    return result;
  };

  return { explore, state };
};

/* ------------------------------------------------------------------ *
 * Main entry point
 * ------------------------------------------------------------------ */

export const OUTCOME_ELECTED = 'elected';
export const OUTCOME_REFERRAL = 'referral';
export const OUTCOME_NO_BALLOTS = 'no-ballots';

/**
 * Run the full count and produce an auditable report.
 *
 * @param {Object} input
 * @param {Array<{id:string,name:string}>} input.candidates    in nomination order
 * @param {Array<Object>} input.ballots                        ledger, in serial order
 * @param {string} [input.electionTypeId]
 */
export const runCount = ({ candidates, ballots, electionTypeId = DEFAULT_ELECTION_TYPE }) => {
  const electionType = getElectionType(electionTypeId);
  const candidateById = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate]));
  const orderedCandidateIds = candidates.map((candidate) => candidate.id);

  const classifiedBallots = ballots.map((ballot) => classifyBallot(ballot, candidates));

  const formalBallots = classifiedBallots.filter((ballot) => ballot.status === BALLOT_FORMAL);
  const informalBallots = classifiedBallots.filter((ballot) => ballot.status === BALLOT_INFORMAL);
  const voidedBallots = classifiedBallots.filter((ballot) => ballot.status === BALLOT_VOIDED);
  const flaggedBallots = classifiedBallots.filter((ballot) => ballot.requiresReview);

  const reconciliation = {
    entriesInLedger: classifiedBallots.length,
    voided: voidedBallots.length,
    ballotsAdmitted: classifiedBallots.length - voidedBallots.length,
    formal: formalBallots.length,
    informal: informalBallots.length,
    flaggedForReview: flaggedBallots.length,
  };

  const preferenceLists = formalBallots.map((ballot) => ({
    serial: ballot.serial,
    preferences: ballot.preferences,
  }));

  const base = {
    rulesVersion: RULES_VERSION,
    engineVersion: ENGINE_VERSION,
    electionType,
    candidates,
    candidateById,
    classifiedBallots,
    flaggedBallots,
    reconciliation,
  };

  if (candidates.length < 2) {
    return {
      ...base,
      rounds: [],
      firstPreferences: null,
      outcome: {
        status: OUTCOME_NO_BALLOTS,
        winnerId: null,
        headline: 'Not enough candidates to hold a count.',
        detail: 'A preferential count requires at least two candidates.',
      },
      tieEvents: [],
      checks: [],
    };
  }

  if (formalBallots.length === 0) {
    return {
      ...base,
      rounds: [],
      firstPreferences: null,
      outcome: {
        status: OUTCOME_NO_BALLOTS,
        winnerId: null,
        headline: 'No formal ballots. No candidate can be declared elected.',
        detail:
          reconciliation.entriesInLedger === 0
            ? 'The ballot ledger is empty.'
            : `All ${reconciliation.ballotsAdmitted} admitted ballot(s) were informal.`,
      },
      tieEvents: [],
      checks: [],
    };
  }

  const { explore, state } = buildExplorer(orderedCandidateIds, preferenceLists);
  const overall = explore(orderedCandidateIds);

  // ---- canonical round-by-round trace ----------------------------------
  // Where a tie for exclusion is immaterial, the displayed trace excludes the
  // tied candidate appearing first in nomination order. The trace is only ever
  // displayed when the outcome is certain, so this choice cannot affect who is
  // elected; it is recorded in the report regardless.
  const rounds = [];
  const tieEvents = [];
  let continuingIds = [...orderedCandidateIds];
  let traceWinnerId = null;

  if (!overall.block) {
    for (;;) {
      const round = countRound(continuingIds, preferenceLists);
      const roundNumber = rounds.length + 1;

      const majorityWinner = continuingIds.find((id) => round.counts[id] >= round.majorityThreshold);

      if (majorityWinner !== undefined) {
        rounds.push({
          roundNumber,
          continuingIds: [...continuingIds],
          ...round,
          excludedId: null,
          outcome: 'majority-reached',
          winnerId: majorityWinner,
        });
        traceWinnerId = majorityWinner;
        break;
      }

      if (continuingIds.length === 1) {
        rounds.push({
          roundNumber,
          continuingIds: [...continuingIds],
          ...round,
          excludedId: null,
          outcome: 'last-continuing-candidate',
          winnerId: continuingIds[0],
        });
        traceWinnerId = continuingIds[0];
        break;
      }

      const lowestCount = Math.min(...continuingIds.map((id) => round.counts[id]));
      const lowestIds = continuingIds.filter((id) => round.counts[id] === lowestCount);
      const excludedId = lowestIds[0];

      if (lowestIds.length > 1) {
        tieEvents.push({
          roundNumber,
          candidateIds: [...lowestIds],
          voteCount: lowestCount,
          material: false,
          excludedInTrace: excludedId,
          branchOutcomes: lowestIds.map((candidateId) => ({
            excludedId: candidateId,
            winnerIds: explore(continuingIds.filter((id) => id !== candidateId)).winnerIds ?? [],
          })),
        });
      }

      rounds.push({
        roundNumber,
        continuingIds: [...continuingIds],
        ...round,
        excludedId,
        tiedForExclusionIds: lowestIds.length > 1 ? [...lowestIds] : null,
        outcome: 'exclusion',
        winnerId: null,
      });

      continuingIds = continuingIds.filter((id) => id !== excludedId);
    }
  } else {
    // Produce the trace up to the point of the blocking tie so the Returning
    // Officer can see how the count arrived there.
    for (;;) {
      const round = countRound(continuingIds, preferenceLists);
      const roundNumber = rounds.length + 1;
      const lowestCount = Math.min(...continuingIds.map((id) => round.counts[id]));
      const lowestIds = continuingIds.filter((id) => round.counts[id] === lowestCount);
      const majorityWinner = continuingIds.find((id) => round.counts[id] >= round.majorityThreshold);

      if (majorityWinner !== undefined || continuingIds.length === 1 || round.continuingBallots === 0) {
        rounds.push({
          roundNumber,
          continuingIds: [...continuingIds],
          ...round,
          excludedId: null,
          outcome: 'count-halted',
          winnerId: null,
        });
        break;
      }

      if (lowestIds.length > 1) {
        rounds.push({
          roundNumber,
          continuingIds: [...continuingIds],
          ...round,
          excludedId: null,
          tiedForExclusionIds: [...lowestIds],
          outcome: 'count-halted',
          winnerId: null,
        });
        break;
      }

      rounds.push({
        roundNumber,
        continuingIds: [...continuingIds],
        ...round,
        excludedId: lowestIds[0],
        tiedForExclusionIds: null,
        outcome: 'exclusion',
        winnerId: null,
      });

      continuingIds = continuingIds.filter((id) => id !== lowestIds[0]);
    }
  }

  const firstRound = countRound(orderedCandidateIds, preferenceLists);
  const firstPreferences = {
    counts: firstRound.counts,
    totalFormal: formalBallots.length,
    majorityThreshold: firstRound.majorityThreshold,
  };

  if (overall.block) {
    const tiedIds = orderedCandidateIds.filter((id) => overall.block.candidateIds.includes(id));

    return {
      ...base,
      rounds,
      firstPreferences,
      tieEvents,
      explored: state.visited,
      outcome: {
        status: OUTCOME_REFERRAL,
        winnerId: null,
        reason: overall.block.reason,
        candidateIds: tiedIds,
        headline:
          overall.block.reason === 'complexity-limit' || overall.block.reason === 'no-support'
            ? 'The count could not determine a winner. Referral required.'
            : 'The count resulted in a tie. No winner may be declared by this count.',
        detail: BLOCK_REASONS[overall.block.reason],
        instruction: electionType.tieInstruction,
        authority: electionType.tieAuthority,
      },
      checks: buildChecks({ rounds, firstPreferences, winnerId: null, formalBallots, reconciliation }),
    };
  }

  const winnerId = overall.winnerIds[0];

  // Sanity: the canonical trace must agree with the exhaustive exploration.
  // If it ever does not, the result is not trustworthy and must not be declared.
  if (traceWinnerId !== winnerId) {
    return {
      ...base,
      rounds,
      firstPreferences,
      tieEvents,
      explored: state.visited,
      outcome: {
        status: OUTCOME_REFERRAL,
        winnerId: null,
        reason: 'internal-disagreement',
        candidateIds: dedupe([traceWinnerId, winnerId].filter(Boolean)),
        headline: 'The count did not verify. No winner may be declared.',
        detail:
          'The round-by-round trace and the exhaustive check disagreed. This indicates a defect; the count must be performed manually.',
        instruction: electionType.tieInstruction,
        authority: electionType.tieAuthority,
      },
      checks: [],
    };
  }

  const finalRound = rounds[rounds.length - 1];

  return {
    ...base,
    rounds,
    firstPreferences,
    tieEvents,
    explored: state.visited,
    outcome: {
      status: OUTCOME_ELECTED,
      winnerId,
      headline: `${candidateById[winnerId].name} is elected.`,
      detail:
        finalRound.outcome === 'majority-reached'
          ? `Reached ${finalRound.counts[winnerId]} of ${finalRound.continuingBallots} votes counted in round ${finalRound.roundNumber} (more than 50% required ${finalRound.majorityThreshold}).`
          : `Last continuing candidate after ${rounds.length} round(s), holding ${finalRound.counts[winnerId]} of ${finalRound.continuingBallots} votes counted.`,
      authority: electionType.countAuthority,
      immaterialTies: tieEvents.length,
    },
    checks: buildChecks({ rounds, firstPreferences, winnerId, formalBallots, reconciliation }),
  };
};

/* ------------------------------------------------------------------ *
 * Self-checks printed alongside the result
 * ------------------------------------------------------------------ */

/**
 * Arithmetic identities a human can verify by hand against the printed report.
 * These are assertions about the engine's own output, not about the ballots.
 */
const buildChecks = ({ rounds, firstPreferences, winnerId, formalBallots, reconciliation }) => {
  const checks = [];

  checks.push({
    label: 'Ledger reconciles',
    detail: `${reconciliation.entriesInLedger} entries = ${reconciliation.formal} formal + ${reconciliation.informal} informal + ${reconciliation.voided} voided`,
    pass:
      reconciliation.formal + reconciliation.informal + reconciliation.voided === reconciliation.entriesInLedger,
  });

  rounds.forEach((round) => {
    const summed = Object.values(round.counts).reduce((total, value) => total + value, 0);
    checks.push({
      label: `Round ${round.roundNumber} totals`,
      detail: `${summed} votes + ${round.exhaustedBallots} exhausted = ${reconciliation.formal} formal ballots`,
      pass: summed === round.continuingBallots && summed + round.exhaustedBallots === formalBallots.length,
    });
  });

  for (let index = 1; index < rounds.length; index += 1) {
    const previous = rounds[index - 1];
    const current = rounds[index];
    checks.push({
      label: `Round ${current.roundNumber} continuing candidates`,
      detail: `${previous.continuingIds.length} continuing less 1 excluded = ${current.continuingIds.length}`,
      pass: current.continuingIds.length === previous.continuingIds.length - 1,
    });
  }

  if (firstPreferences) {
    const summed = Object.values(firstPreferences.counts).reduce((total, value) => total + value, 0);
    checks.push({
      label: 'First preferences account for every formal ballot',
      detail: `${summed} first preferences = ${formalBallots.length} formal ballots`,
      pass: summed === formalBallots.length,
    });
  }

  if (winnerId && rounds.length > 0) {
    const finalRound = rounds[rounds.length - 1];
    checks.push({
      label: 'Winner holds more than 50% of votes counted in the final round',
      detail: `${finalRound.counts[winnerId]} of ${finalRound.continuingBallots} (needs more than ${finalRound.continuingBallots / 2})`,
      pass: finalRound.counts[winnerId] * 2 > finalRound.continuingBallots,
    });
  }

  return checks;
};

/* ------------------------------------------------------------------ *
 * Disclosure: s 2.05(i) literal reading
 * ------------------------------------------------------------------ */

/**
 * s 2.05(i) speaks of "more than 50% of the 1st preference votes", while a
 * conventional preferential count tests the majority against the ballots still
 * counted in the current round (exhausted ballots having left the count).
 * Those denominators differ as soon as any ballot exhausts.
 *
 * The count applies the conventional system, as s 2.05(i) directs. This
 * function reports both measures so the Returning Officer can see the
 * difference rather than take it on trust.
 */
export const majorityDisclosure = (result) => {
  if (result.outcome.status !== OUTCOME_ELECTED || result.rounds.length === 0) {
    return null;
  }

  const winnerId = result.outcome.winnerId;
  const finalRound = result.rounds[result.rounds.length - 1];
  const totalFormal = result.reconciliation.formal;
  const winnerVotes = finalRound.counts[winnerId];
  const firstPreferenceVotes = result.firstPreferences.counts[winnerId] ?? 0;

  return {
    winnerVotes,
    continuingBallots: finalRound.continuingBallots,
    exhaustedBallots: finalRound.exhaustedBallots,
    totalFormal,
    firstPreferenceVotes,
    majorityOfContinuing: winnerVotes * 2 > finalRound.continuingBallots,
    majorityOfAllFormal: winnerVotes * 2 > totalFormal,
    majorityOnFirstPreferences: firstPreferenceVotes * 2 > totalFormal,
    divergent: finalRound.exhaustedBallots > 0 && winnerVotes * 2 <= totalFormal,
  };
};

/* ------------------------------------------------------------------ *
 * Canonical record and integrity digest
 * ------------------------------------------------------------------ */

/**
 * A stable, line-oriented transcription of everything the count depends on.
 * Identical input always produces an identical string, so its digest detects
 * any alteration of the ledger between counting and declaration.
 *
 * Deliberately uses candidate names and ballot serials rather than internal
 * ids, so that an auditor holding only the printed report and the paper slips
 * can regenerate it.
 */
export const canonicalRecord = ({ positionTitle, electionTypeId, candidates, ballots }) => {
  const lines = [];
  const indexById = new Map(candidates.map((candidate, index) => [candidate.id, index + 1]));

  lines.push(`rules\t${RULES_VERSION}`);
  lines.push(`engine\t${ENGINE_VERSION}`);
  lines.push(`position\t${positionTitle}`);
  lines.push(`type\t${getElectionType(electionTypeId).id}`);
  lines.push(`candidates\t${candidates.length}`);

  candidates.forEach((candidate, index) => {
    lines.push(`candidate\t${index + 1}\t${candidate.name}`);
  });

  lines.push(`ballots\t${ballots.length}`);

  [...ballots]
    .sort((left, right) => left.serial - right.serial)
    .forEach((ballot) => {
      const marks = Object.entries(ballot.marks ?? {})
        .filter(([candidateId, value]) => indexById.has(candidateId) && String(value ?? '').trim() !== '')
        .map(([candidateId, value]) => [indexById.get(candidateId), String(value).trim()])
        .sort((left, right) => left[0] - right[0])
        .map(([index, value]) => `${index}=${value}`)
        .join(',');

      const status = ballot.voided ? 'voided' : ballot.informal ? 'informal' : 'counted';
      lines.push(`ballot\t${ballot.serial}\t${status}\t${marks}`);
    });

  return `${lines.join('\n')}\n`;
};

/**
 * SHA-256 (FIPS 180-4), implemented here rather than via Web Crypto so the
 * digest is synchronous and available regardless of how the page is served.
 * The output matches `sha256sum` on the exported record file, which is how an
 * auditor is expected to check it.
 */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (value, bits) => ((value >>> bits) | (value << (32 - bits))) >>> 0;

export const sha256Hex = (text) => {
  const message = new TextEncoder().encode(text);
  const bitLength = message.length * 8;

  // Pad to a multiple of 64 bytes: 0x80, zeroes, then the 64-bit length.
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const block = new Uint8Array(paddedLength);
  block.set(message);
  block[message.length] = 0x80;
  const view = new DataView(block.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const schedule = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4);
    }

    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(schedule[index - 15], 7) ^ rotr(schedule[index - 15], 18) ^ (schedule[index - 15] >>> 3);
      const s1 = rotr(schedule[index - 2], 17) ^ rotr(schedule[index - 2], 19) ^ (schedule[index - 2] >>> 10);
      schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;

    for (let index = 0; index < 64; index += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + choose + SHA256_K[index] + schedule[index]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    [a, b, c, d, e, f, g, h].forEach((word, index) => {
      hash[index] = (hash[index] + word) >>> 0;
    });
  }

  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
};

/** SHA-256 of the canonical record, hex encoded. */
export const digestRecord = (record) => ({ algorithm: 'SHA-256', hex: sha256Hex(record) });
