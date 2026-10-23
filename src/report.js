/**
 * Builds the official PDF count report from a count result.
 *
 * The report is designed to be self-contained: a reader holding only the PDF
 * and the paper slips can re-perform the entire count by hand and arrive at
 * the same conclusion. That means it must publish the full ballot ledger, not
 * just the totals, and it must state the rule applied at every step.
 */

import {
  FLAG_DESCRIPTIONS,
  OUTCOME_ELECTED,
  OUTCOME_NO_BALLOTS,
  OUTCOME_REFERRAL,
  canonicalRecord,
  digestRecord,
  majorityDisclosure,
} from './counting.js';
import { PdfDocument } from './pdf.js';

const CLUB_NAME = "The University Engineers' Club";
const CONSTITUTION_LABEL = 'UEC Constitution, 7 August 2026';

const percentage = (part, whole) => (whole === 0 ? '-' : `${((part / whole) * 100).toFixed(1)}%`);

const formatTimestamp = (date) =>
  `${date.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })} at ${date.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

const marksAsTranscribed = (ballot, candidates) =>
  candidates
    .map((candidate, index) => ({ index: index + 1, candidate, rank: ballot.marks[candidate.id] }))
    .filter((entry) => entry.rank !== undefined)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => `${entry.rank}=${entry.candidate.name}`)
    .join(', ') || '(blank)';

const countedPreferences = (ballot, candidateById) =>
  ballot.preferences.map((candidateId, index) => `${index + 1}. ${candidateById[candidateId].name}`).join('  ') ||
  '(not counted)';

const statusLabel = {
  formal: 'Formal',
  informal: 'INFORMAL',
  voided: 'VOIDED',
};

/**
 * @param {Object} input
 * @param {Object} input.result            output of runCount()
 * @param {string} input.positionTitle
 * @param {Array}  input.ballots           raw ledger (for the canonical record)
 * @param {string} input.returningOfficer
 * @param {string} [input.scrutineers]
 * @param {Date}   [input.generatedAt]
 * @returns {{bytes:Uint8Array, fileName:string, digest:{algorithm:string,hex:string}, record:string}}
 */
export const buildCountReport = ({
  result,
  positionTitle,
  ballots,
  returningOfficer = '',
  scrutineers = '',
  generatedAt = new Date(),
}) => {
  const { candidates, candidateById, reconciliation, rounds, firstPreferences, outcome, electionType } = result;

  const record = canonicalRecord({
    positionTitle,
    electionTypeId: electionType.id,
    candidates,
    ballots,
  });
  const digest = digestRecord(record);

  const doc = new PdfDocument({
    title: `${positionTitle} - count report`,
    subject: `${CLUB_NAME} preferential count under ${electionType.countAuthority}`,
    footer: `${positionTitle} | ${CLUB_NAME} | record ${digest.hex.slice(0, 16)}`,
    created: generatedAt,
  });

  /* ---------------- 1. Heading and declaration ---------------- */

  doc.paragraph(CLUB_NAME.toUpperCase(), { size: 8.5, font: 'bold', gray: 0.45, gapAfter: 2 });
  doc.title1(`Count report: ${positionTitle}`);
  doc.paragraph(
    `Preferential count conducted under ${electionType.countAuthority} of the ${CONSTITUTION_LABEL}.`,
    { size: 9.5, gray: 0.35, gapAfter: 10 },
  );

  doc.definitions([
    ['Position', positionTitle],
    ['Ballot type', electionType.label],
    ['Counting authority', `${electionType.countAuthority} (${CONSTITUTION_LABEL})`],
    ['Report generated', formatTimestamp(generatedAt)],
    ['Returning Officer', returningOfficer || '__________________________'],
    ['Scrutineers present', scrutineers || '__________________________'],
    ['Ballot record digest', `${digest.algorithm}: ${digest.hex}`],
  ]);

  if (outcome.status === OUTCOME_ELECTED) {
    doc.callout(
      [
        { text: 'RESULT: CANDIDATE ELECTED', size: 9, font: 'bold' },
        { text: candidateById[outcome.winnerId].name, size: 17, font: 'bold' },
        { text: outcome.detail, size: 10 },
        {
          text: `Determined under ${outcome.authority}. This count applied the rule in s 2.05(i): a candidate is elected on receiving more than 50% of the votes counted, with the preferences of excluded candidates distributed in order.`,
          size: 8.5,
        },
      ],
      { gray: 0.94, borderGray: 0.2 },
    );

    if (outcome.immaterialTies > 0) {
      doc.paragraph(
        `Note: ${outcome.immaterialTies} tie(s) for exclusion arose during the count. Each was tested against every lawful exclusion order and none could change the result, so no referral was required. The detail is set out under "Ties arising during the count" below.`,
        { size: 9, gray: 0.3 },
      );
    }
  } else if (outcome.status === OUTCOME_REFERRAL) {
    doc.callout(
      [
        { text: 'RESULT: NO CANDIDATE ELECTED BY THIS COUNT', size: 9, font: 'bold' },
        { text: outcome.headline, size: 13, font: 'bold' },
        { text: outcome.detail, size: 10 },
        {
          text: `Candidates affected: ${outcome.candidateIds
            .map((candidateId) => candidateById[candidateId].name)
            .join(', ')}`,
          size: 10,
          font: 'bold',
        },
        { text: `Required next step under ${outcome.authority}:`, size: 9, font: 'bold' },
        { text: outcome.instruction, size: 10 },
      ],
      { gray: 0.9, borderGray: 0 },
    );

    doc.paragraph(
      'This program does not and may not break a tie. The Constitution reserves that decision to the Committee. No part of this report should be read as declaring a winner.',
      { size: 9, font: 'bold', gray: 0.2 },
    );
  } else if (outcome.status === OUTCOME_NO_BALLOTS) {
    doc.callout(
      [
        { text: 'RESULT: NO COUNT POSSIBLE', size: 9, font: 'bold' },
        { text: outcome.headline, size: 13, font: 'bold' },
        { text: outcome.detail, size: 10 },
      ],
      { gray: 0.9, borderGray: 0 },
    );
  }

  doc.paragraph(electionType.scrutinyNote, { size: 8.5, gray: 0.4, gapBefore: 2 });

  /* ---------------- 2. Ballot reconciliation ---------------- */

  doc.heading('Ballot reconciliation');

  doc.table({
    columns: [
      { header: 'Category', width: 60 },
      { header: 'Ballots', width: 18, align: 'right' },
      { header: 'Basis', width: 42 },
    ],
    rows: [
      ['Entries in the ballot ledger', reconciliation.entriesInLedger, 'Every slip transcribed'],
      ['Less entries voided by the Returning Officer', reconciliation.voided, 'Excluded from all totals'],
      ['Ballots admitted to the count', reconciliation.ballotsAdmitted, 'Ledger less voided'],
      ['Informal (not counted)', reconciliation.informal, 'No determinable first preference'],
      ['Formal (counted)', reconciliation.formal, 'Admitted less informal'],
      ['Formal ballots flagged for review', reconciliation.flaggedForReview, 'Listed in full below'],
    ],
    emphasise: [false, false, true, false, true, false],
  });

  /* ---------------- 3. First preferences ---------------- */

  doc.heading('First preference votes');

  if (firstPreferences) {
    doc.paragraph(
      `First preferences are the number 1 marks on formal ballots. ${firstPreferences.totalFormal} formal ballot(s) were counted, so a candidate needed ${firstPreferences.majorityThreshold} first preference vote(s) to exceed 50% and be elected without any distribution of preferences.`,
      { size: 9, gray: 0.3 },
    );

    const firstPreferenceRows = candidates
      .map((candidate) => ({
        candidate,
        votes: firstPreferences.counts[candidate.id] ?? 0,
      }))
      .sort((left, right) => right.votes - left.votes || left.candidate.name.localeCompare(right.candidate.name))
      .map((entry) => [
        entry.candidate.name,
        String(entry.votes),
        percentage(entry.votes, firstPreferences.totalFormal),
        entry.votes >= firstPreferences.majorityThreshold ? 'Yes' : 'No',
      ]);

    const firstPreferenceTotal = Object.values(firstPreferences.counts).reduce(
      (total, value) => total + value,
      0,
    );

    doc.table({
      columns: [
        { header: 'Candidate', width: 46 },
        { header: '1st preferences', width: 20, align: 'right' },
        { header: 'Share of formal', width: 18, align: 'right' },
        { header: 'Over 50%?', width: 16, align: 'right' },
      ],
      rows: [
        ...firstPreferenceRows,
        ['TOTAL', String(firstPreferenceTotal), percentage(firstPreferenceTotal, firstPreferences.totalFormal), ''],
      ],
      emphasise: [...firstPreferenceRows.map(() => false), true],
    });

    doc.paragraph(
      'Candidates are listed in descending order of first preference votes. The total must equal the number of formal ballots; if it does not, the count is invalid.',
      { size: 8.5, gray: 0.45 },
    );
  } else {
    doc.paragraph('No formal ballots were available, so there are no first preference votes to report.', {
      size: 10,
    });
  }

  /* ---------------- 4. Round-by-round progress ---------------- */

  doc.heading('Round-by-round count');

  if (rounds.length === 0) {
    doc.paragraph('No rounds were counted.', { size: 10 });
  } else {
    doc.paragraph(
      'Each column is one round of the count. A candidate who has been excluded shows a dash. "Excl." marks the candidate excluded at the end of that round; their ballots pass to the next preference still continuing.',
      { size: 9, gray: 0.3 },
    );

    const roundColumns = rounds.map((round) => ({
      header: `Round ${round.roundNumber}`,
      width: 100 / rounds.length,
      align: 'right',
    }));

    const candidateRows = candidates.map((candidate) =>
      [candidate.name].concat(
        rounds.map((round) => {
          if (!round.continuingIds.includes(candidate.id)) {
            return '-';
          }
          const votes = String(round.counts[candidate.id]);
          return round.excludedId === candidate.id ? `${votes}  Excl.` : votes;
        }),
      ),
    );

    const summaryRows = [
      ['Votes counted this round'].concat(rounds.map((round) => String(round.continuingBallots))),
      ['Ballots exhausted'].concat(rounds.map((round) => String(round.exhaustedBallots))),
      ['Votes needed for more than 50%'].concat(rounds.map((round) => String(round.majorityThreshold))),
    ];

    doc.table({
      columns: [{ header: 'Candidate', width: 160 }].concat(roundColumns),
      rows: [...candidateRows, ...summaryRows],
      emphasise: [...candidateRows.map(() => false), true, true, true],
      size: rounds.length > 6 ? 8 : 9.5,
    });

    doc.table({
      caption: 'Result of each round',
      columns: [
        { header: 'Round', width: 12, align: 'right' },
        { header: 'Continuing', width: 14, align: 'right' },
        { header: 'Outcome of the round', width: 74 },
      ],
      rows: rounds.map((round) => {
        let description;

        if (round.outcome === 'majority-reached') {
          description = `${candidateById[round.winnerId].name} reached ${round.counts[round.winnerId]} of ${
            round.continuingBallots
          } votes counted (needed ${round.majorityThreshold}) and is elected.`;
        } else if (round.outcome === 'last-continuing-candidate') {
          description = `${candidateById[round.winnerId].name} is the last continuing candidate, holding ${
            round.counts[round.winnerId]
          } of ${round.continuingBallots} votes counted.`;
        } else if (round.outcome === 'count-halted') {
          description = round.tiedForExclusionIds
            ? `Count halted. ${round.tiedForExclusionIds
                .map((candidateId) => candidateById[candidateId].name)
                .join(' and ')} are equally lowest and the choice between them is not the counter's to make.`
            : 'Count halted; no candidate can be elected on these ballots.';
        } else {
          const base = `No candidate had more than 50%. ${
            candidateById[round.excludedId].name
          } was lowest on ${round.counts[round.excludedId]} vote(s) and was excluded.`;
          description = round.tiedForExclusionIds
            ? `${base} ${round.tiedForExclusionIds
                .map((candidateId) => candidateById[candidateId].name)
                .join(' and ')} were tied on that figure; every exclusion order was tested and all produced the same winner.`
            : base;
        }

        return [String(round.roundNumber), String(round.continuingIds.length), description];
      }),
    });
  }

  /* ---------------- 5. Ties ---------------- */

  if (result.tieEvents?.length) {
    doc.heading('Ties arising during the count');

    doc.paragraph(
      'Where two or more candidates were equally lowest, the count did not pick one. Instead every lawful exclusion order was followed to its conclusion. The tie was treated as immaterial only because all of them elected the same candidate; had any differed, the count would have halted for referral.',
      { size: 9, gray: 0.3 },
    );

    doc.table({
      columns: [
        { header: 'Round', width: 10, align: 'right' },
        { header: 'Candidates tied', width: 30 },
        { header: 'Votes', width: 10, align: 'right' },
        { header: 'If excluded, the candidate elected would be', width: 50 },
      ],
      rows: result.tieEvents.flatMap((event) =>
        event.branchOutcomes.map((branch, branchIndex) => [
          branchIndex === 0 ? String(event.roundNumber) : '',
          branchIndex === 0
            ? event.candidateIds.map((candidateId) => candidateById[candidateId].name).join(', ')
            : '',
          branchIndex === 0 ? String(event.voteCount) : '',
          `exclude ${candidateById[branch.excludedId].name} -> ${
            branch.winnerIds.map((candidateId) => candidateById[candidateId].name).join(' or ') || 'no winner'
          }`,
        ]),
      ),
    });
  }

  /* ---------------- 6. Majority basis disclosure ---------------- */

  const disclosure = majorityDisclosure(result);

  if (disclosure) {
    doc.heading('Basis of the majority');

    doc.paragraph(
      's 2.05(i) requires a conventional preferential count and speaks of more than 50% of the votes. Once a ballot runs out of marked preferences it is exhausted and leaves the count, so the majority is measured against the ballots still being counted. Both measures are published here so the difference is visible rather than assumed.',
      { size: 9, gray: 0.3 },
    );

    doc.table({
      columns: [
        { header: 'Measure', width: 58 },
        { header: 'Figure', width: 22, align: 'right' },
        { header: 'Over 50%?', width: 20, align: 'right' },
      ],
      rows: [
        [
          'Winner’s votes against ballots still counted in the final round (rule applied)',
          `${disclosure.winnerVotes} of ${disclosure.continuingBallots}`,
          disclosure.majorityOfContinuing ? 'Yes' : 'No',
        ],
        [
          'Winner’s votes against all formal ballots cast',
          `${disclosure.winnerVotes} of ${disclosure.totalFormal}`,
          disclosure.majorityOfAllFormal ? 'Yes' : 'No',
        ],
        [
          'Winner’s first preference votes against all formal ballots',
          `${disclosure.firstPreferenceVotes} of ${disclosure.totalFormal}`,
          disclosure.majorityOnFirstPreferences ? 'Yes' : 'No',
        ],
        ['Ballots exhausted by the final round', String(disclosure.exhaustedBallots), ''],
      ],
      emphasise: [true, false, false, false],
    });

    if (disclosure.divergent) {
      doc.callout(
        [
          { text: 'DISCLOSURE', size: 9, font: 'bold' },
          {
            text: `The elected candidate holds a majority of the ballots still being counted, but not of all ${disclosure.totalFormal} formal ballots cast, because ${disclosure.exhaustedBallots} ballot(s) were exhausted. This is the ordinary consequence of a conventional preferential count where voters do not number every square. It is recorded here for the Returning Officer's attention.`,
            size: 9.5,
          },
        ],
        { gray: 0.95, borderGray: 0.45 },
      );
    }
  }

  /* ---------------- 7. Arithmetic checks ---------------- */

  if (result.checks?.length) {
    doc.heading('Arithmetic checks');

    doc.paragraph(
      'Each identity below can be verified by hand against the tables in this report. Any failure means the report must not be relied upon.',
      { size: 9, gray: 0.3 },
    );

    doc.table({
      columns: [
        { header: 'Check', width: 40 },
        { header: 'Arithmetic', width: 48 },
        { header: 'Result', width: 12, align: 'right' },
      ],
      rows: result.checks.map((check) => [check.label, check.detail, check.pass ? 'PASS' : 'FAIL']),
      emphasise: result.checks.map((check) => !check.pass),
    });
  }

  /* ---------------- 8. Ballots requiring adjudication ---------------- */

  doc.heading('Ballots requiring the Returning Officer’s attention');

  if (result.flaggedBallots.length === 0) {
    doc.paragraph('No ballot required adjudication. Every slip was either numbered cleanly or wholly blank.', {
      size: 10,
    });
  } else {
    doc.paragraph(
      'Each slip below departed from clean sequential numbering. The rule applied is conventional: preferences are read from 1 upwards and stop at the first number that is missing or repeated. Nothing was discarded silently; every slip is listed with the marks as transcribed and what was counted from it.',
      { size: 9, gray: 0.3 },
    );

    doc.table({
      columns: [
        { header: 'Slip', width: 8, align: 'right' },
        { header: 'Status', width: 12 },
        { header: 'Marks as transcribed', width: 32 },
        { header: 'Counted as', width: 22 },
        { header: 'Reason flagged', width: 26 },
      ],
      rows: result.flaggedBallots.map((ballot) => [
        String(ballot.serial),
        statusLabel[ballot.status] ?? ballot.status,
        marksAsTranscribed(ballot, candidates),
        countedPreferences(ballot, candidateById),
        ballot.flags.map((flag) => FLAG_DESCRIPTIONS[flag] ?? flag).join(' '),
      ]),
    });
  }

  /* ---------------- 9. Full ledger ---------------- */

  doc.pageBreak();
  doc.heading('Complete ballot ledger');

  doc.paragraph(
    'Every slip as transcribed, in the order entered. "Marks as transcribed" is the literal record of the numbers written on the slip; "counted as" is the preference order used in the count. This table is what makes the count re-performable: with the paper slips to hand, a scrutineer can verify each line and then redo the arithmetic in the tables above.',
    { size: 9, gray: 0.3 },
  );

  if (result.classifiedBallots.length === 0) {
    doc.paragraph('The ballot ledger is empty.', { size: 10, font: 'bold' });
  } else {
    doc.table({
      columns: [
        { header: 'Slip', width: 8, align: 'right' },
        { header: 'Status', width: 12 },
        { header: 'Marks as transcribed', width: 40 },
        { header: 'Counted as', width: 40 },
      ],
      rows: result.classifiedBallots.map((ballot) => [
        String(ballot.serial),
        statusLabel[ballot.status] ?? ballot.status,
        marksAsTranscribed(ballot, candidates),
        countedPreferences(ballot, candidateById),
      ]),
      emphasise: result.classifiedBallots.map((ballot) => ballot.status !== 'formal'),
      size: 8.5,
    });
  }

  /* ---------------- 10. Integrity and signatures ---------------- */

  doc.heading('Integrity of this report');

  doc.paragraph(
    'The digest below is the SHA-256 of a canonical transcription of the candidates and every ballot mark in this count. It is reproduced in the footer of each page. Export the ballot record alongside this report; running a standard SHA-256 over that file must produce exactly this value. Any later alteration to the ledger, however small, changes the digest.',
    { size: 9, gray: 0.3 },
  );

  doc.definitions([
    ['Algorithm', digest.algorithm],
    ['Ballot record digest', digest.hex],
    ['Counting rules', `${result.rulesVersion} (engine ${result.engineVersion})`],
    ['Ballot entries covered', `${reconciliation.entriesInLedger} (serials 1 to ${reconciliation.entriesInLedger})`],
  ]);

  doc.spacer(6);
  doc.paragraph('Certification', { size: 11, font: 'bold', gray: 0, gapAfter: 4 });
  doc.paragraph(
    outcome.status === OUTCOME_ELECTED
      ? 'We certify that the ballots were counted as recorded in this report and that the candidate named in the declaration is elected.'
      : 'We certify that the ballots were counted as recorded in this report and that no candidate was elected by this count.',
    { size: 9.5, gray: 0.2 },
  );

  doc.signatureBlock(['Returning Officer', 'Returning Officer / Secretary', 'Scrutineer', 'Scrutineer']);

  const safeTitle = positionTitle.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'position';
  const stamp = generatedAt.toISOString().slice(0, 16).replace(/[-:T]/g, '');

  return {
    bytes: doc.toBytes(),
    fileName: `uec-count-${safeTitle}-${stamp}.pdf`,
    digest,
    record,
  };
};
