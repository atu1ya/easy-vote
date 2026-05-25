import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const createId = () => {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const createCandidateRow = (name = '') => ({
  id: createId(),
  name,
});

const ordinalLabel = (place) => {
  if (place === 1) return '1st Place';
  if (place === 2) return '2nd Place';
  if (place === 3) return '3rd Place';
  return `${place}th Place`;
};

const getRankLabel = (rank) => {
  if (rank === 1) return '1';
  if (rank === 2) return '2';
  if (rank === 3) return '3';
  return String(rank);
};

const buildBallotOrder = (ranksByCandidateId) => {
  return Object.entries(ranksByCandidateId)
    .map(([candidateId, rank]) => ({ candidateId, rank: Number(rank) }))
    .filter((entry) => Number.isInteger(entry.rank) && entry.rank > 0)
    .sort((left, right) => left.rank - right.rank)
    .map((entry) => entry.candidateId);
};

const getHighestRankCount = (ballots) => {
  let highestRank = 0;

  ballots.forEach((ballot) => {
    highestRank = Math.max(highestRank, ballot.length);
  });

  return highestRank;
};

const resolveEliminationTie = (tiedCandidateIds, ballots) => {
  const maxRank = getHighestRankCount(ballots);

  for (let rank = 2; rank <= maxRank; rank += 1) {
    const supportByCandidateId = Object.fromEntries(tiedCandidateIds.map((candidateId) => [candidateId, 0]));

    ballots.forEach((ballot) => {
      const rankedCandidateId = ballot[rank - 1];

      if (rankedCandidateId && Object.hasOwn(supportByCandidateId, rankedCandidateId)) {
        supportByCandidateId[rankedCandidateId] += 1;
      }
    });

    const supportValues = tiedCandidateIds.map((candidateId) => supportByCandidateId[candidateId]);
    const minimumSupport = Math.min(...supportValues);
    const maximumSupport = Math.max(...supportValues);

    if (minimumSupport !== maximumSupport) {
      const lowestSupportCandidates = tiedCandidateIds.filter((candidateId) => supportByCandidateId[candidateId] === minimumSupport);

      if (lowestSupportCandidates.length === 1) {
        return lowestSupportCandidates[0];
      }
    }
  }

  return null;
};

const calculatePreferentialResults = (candidates, ballots) => {
  const candidateById = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate]));
  let activeCandidateIds = candidates.map((candidate) => candidate.id);
  const eliminatedOrder = [];
  const roundSummaries = [];
  const finalVoteTotals = {};

  while (activeCandidateIds.length > 0) {
    const voteCounts = Object.fromEntries(activeCandidateIds.map((candidateId) => [candidateId, 0]));
    let activeBallotCount = 0;

    ballots.forEach((ballot) => {
      const topRemainingChoice = ballot.find((candidateId) => activeCandidateIds.includes(candidateId));

      if (topRemainingChoice) {
        voteCounts[topRemainingChoice] += 1;
        activeBallotCount += 1;
      }
    });

    activeCandidateIds.forEach((candidateId) => {
      finalVoteTotals[candidateId] = voteCounts[candidateId];
    });

    roundSummaries.push({
      roundNumber: roundSummaries.length + 1,
      activeCandidateIds: [...activeCandidateIds],
      voteCounts,
      activeBallotCount,
    });

    const majorityWinnerId = activeCandidateIds.find((candidateId) => voteCounts[candidateId] > activeBallotCount / 2);

    if (majorityWinnerId) {
      const placementOrder = [majorityWinnerId, ...eliminatedOrder.slice().reverse()];

      return {
        candidateById,
        roundSummaries,
        finalVoteTotals,
        placementOrder,
        winnerId: majorityWinnerId,
        isTieStop: false,
        tieMessage: '',
      };
    }

    if (activeCandidateIds.length === 1) {
      const placementOrder = [activeCandidateIds[0], ...eliminatedOrder.slice().reverse()];

      return {
        candidateById,
        roundSummaries,
        finalVoteTotals,
        placementOrder,
        winnerId: activeCandidateIds[0],
        isTieStop: false,
        tieMessage: '',
      };
    }

    const minimumVoteTotal = Math.min(...activeCandidateIds.map((candidateId) => voteCounts[candidateId]));
    const tiedForElimination = activeCandidateIds.filter((candidateId) => voteCounts[candidateId] === minimumVoteTotal);

    if (activeCandidateIds.length === 2 && tiedForElimination.length === 2) {
      const tiedNames = tiedForElimination.map((candidateId) => candidateById[candidateId].name).join(' and ');

      return {
        candidateById,
        roundSummaries,
        finalVoteTotals,
        placementOrder: [...eliminatedOrder.slice().reverse(), ...activeCandidateIds],
        winnerId: null,
        isTieStop: true,
        tieMessage: `The final two candidates, ${tiedNames}, are tied. Manual determination is required under your election rules.`,
      };
    }

    let eliminatedCandidateId = tiedForElimination[0];

    if (tiedForElimination.length > 1) {
      const resolvedLoserId = resolveEliminationTie(tiedForElimination, ballots);

      if (!resolvedLoserId) {
        const tiedNames = tiedForElimination.map((candidateId) => candidateById[candidateId].name).join(', ');

        return {
          candidateById,
          roundSummaries,
          finalVoteTotals,
          placementOrder: [...eliminatedOrder.slice().reverse(), ...activeCandidateIds],
          winnerId: null,
          isTieStop: true,
          tieMessage: `An elimination tie between ${tiedNames} could not be resolved mathematically from the ballot preferences. Manual determination is required.`,
        };
      }

      eliminatedCandidateId = resolvedLoserId;
    }

    eliminatedOrder.push(eliminatedCandidateId);
    activeCandidateIds = activeCandidateIds.filter((candidateId) => candidateId !== eliminatedCandidateId);
  }

  return {
    candidateById,
    roundSummaries,
    finalVoteTotals,
    placementOrder: eliminatedOrder.slice().reverse(),
    winnerId: null,
    isTieStop: true,
    tieMessage: 'No winner could be determined from the submitted ballots.',
  };
};

const App = () => {
  const [phase, setPhase] = useState('setup');
  const [positionTitle, setPositionTitle] = useState('');
  const [setupCandidates, setSetupCandidates] = useState(() => [createCandidateRow(''), createCandidateRow('')]);
  const [lockedPositionTitle, setLockedPositionTitle] = useState('');
  const [lockedCandidates, setLockedCandidates] = useState([]);
  const [currentRanks, setCurrentRanks] = useState({});
  const [ballots, setBallots] = useState([]);
  const [entryError, setEntryError] = useState('');
  const [setupError, setSetupError] = useState('');
  const [calculation, setCalculation] = useState(null);

  const candidateCount = lockedCandidates.length;

  const resetToSetup = () => {
    setPhase('setup');
    setPositionTitle('');
    setSetupCandidates([createCandidateRow(''), createCandidateRow('')]);
    setLockedPositionTitle('');
    setLockedCandidates([]);
    setCurrentRanks({});
    setBallots([]);
    setEntryError('');
    setSetupError('');
    setCalculation(null);
  };

  const startTallying = () => {
    const trimmedPositionTitle = positionTitle.trim();
    const preparedCandidates = setupCandidates
      .map((candidate) => ({ ...candidate, name: candidate.name.trim() }))
      .filter((candidate) => candidate.name.length > 0);
    const uniqueNames = new Set(preparedCandidates.map((candidate) => candidate.name.toLowerCase()));

    if (!trimmedPositionTitle) {
      setSetupError('Enter a position title before starting.');
      return;
    }

    if (preparedCandidates.length < 2) {
      setSetupError('Add at least two candidates.');
      return;
    }

    if (uniqueNames.size !== preparedCandidates.length) {
      setSetupError('Candidate names must be unique.');
      return;
    }

    setSetupError('');
    setLockedPositionTitle(trimmedPositionTitle);
    setLockedCandidates(preparedCandidates);
    setCurrentRanks(Object.fromEntries(preparedCandidates.map((candidate) => [candidate.id, ''])));
    setBallots([]);
    setEntryError('');
    setCalculation(null);
    setPhase('entry');
  };

  const addCandidate = () => {
    setSetupCandidates((previousCandidates) => [...previousCandidates, createCandidateRow('')]);
  };

  const updateCandidateName = (candidateId, name) => {
    setSetupCandidates((previousCandidates) =>
      previousCandidates.map((candidate) => (candidate.id === candidateId ? { ...candidate, name } : candidate)),
    );
  };

  const removeCandidate = (candidateId) => {
    setSetupCandidates((previousCandidates) => {
      if (previousCandidates.length <= 2) {
        return previousCandidates;
      }

      return previousCandidates.filter((candidate) => candidate.id !== candidateId);
    });
  };

  const submitBallot = () => {
    const usedRanks = new Set();
    let duplicateRankDetected = false;

    Object.values(currentRanks).forEach((rankValue) => {
      const numericRank = Number(rankValue);
      if (!Number.isInteger(numericRank) || numericRank <= 0) {
        return;
      }

      if (usedRanks.has(numericRank)) {
        duplicateRankDetected = true;
        return;
      }

      usedRanks.add(numericRank);
    });

    if (duplicateRankDetected) {
      setEntryError('Each rank can only be used once on a ballot.');
      return;
    }

    const ballotOrder = buildBallotOrder(currentRanks);

    if (ballotOrder.length === 0) {
      setEntryError('Assign at least one rank before submitting the ballot.');
      return;
    }

    setBallots((previousBallots) => [...previousBallots, ballotOrder]);
    setCurrentRanks(Object.fromEntries(lockedCandidates.map((candidate) => [candidate.id, ''])));
    setEntryError('');
  };

  const finishAndCalculate = () => {
    const result = calculatePreferentialResults(lockedCandidates, ballots);
    setCalculation(result);
    setPhase('results');
  };

  const standings = useMemo(() => {
    if (!calculation) {
      return [];
    }

    return calculation.placementOrder
      .map((candidateId, index) => ({
        candidate: calculation.candidateById[candidateId],
        place: index + 1,
        votes: calculation.finalVoteTotals[candidateId] ?? 0,
      }))
      .filter((entry) => entry.candidate);
  }, [calculation]);

  const renderSetupPhase = () => (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-slate-200 bg-white/90 p-6 shadow-soft backdrop-blur">
        <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-500">Setup</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-slate-950 sm:text-4xl">Paper Ballot Tally</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
          Enter the position and candidates, then lock them in for fast slip-by-slip entry.
        </p>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-soft">
          <label className="block text-sm font-semibold text-slate-700" htmlFor="position-title">
            Position Title
          </label>
          <input
            id="position-title"
            value={positionTitle}
            onChange={(event) => setPositionTitle(event.target.value)}
            placeholder="President"
            className="mt-2 w-full rounded-2xl border border-slate-300 bg-slate-50 px-4 py-3 text-lg text-slate-950 outline-none transition focus:border-slate-950 focus:bg-white"
          />

          <div className="mt-6 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900">Candidates</h2>
              <p className="text-sm text-slate-500">Add every candidate running for this position.</p>
            </div>
            <button
              type="button"
              onClick={addCandidate}
              className="rounded-full border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:border-slate-950 hover:text-slate-950"
            >
              Add Candidate
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {setupCandidates.map((candidate, index) => (
              <div key={candidate.id} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-950 text-sm font-bold text-white">
                  {index + 1}
                </div>
                <input
                  value={candidate.name}
                  onChange={(event) => updateCandidateName(candidate.id, event.target.value)}
                  placeholder={`Candidate ${index + 1}`}
                  className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-base text-slate-950 outline-none transition focus:border-slate-950"
                />
                <button
                  type="button"
                  onClick={() => removeCandidate(candidate.id)}
                  className="rounded-xl px-3 py-2 text-sm font-semibold text-slate-500 transition hover:bg-slate-200 hover:text-slate-950"
                  aria-label={`Remove candidate ${index + 1}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {setupError ? (
            <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700" role="alert">
              {setupError}
            </div>
          ) : null}

          <button
            type="button"
            onClick={startTallying}
            className="mt-6 inline-flex w-full items-center justify-center rounded-2xl bg-slate-950 px-5 py-4 text-base font-bold text-white transition hover:bg-slate-800"
          >
            Start Tallying
          </button>
        </div>

        <aside className="rounded-[2rem] border border-dashed border-slate-300 bg-white/70 p-6 text-slate-700 shadow-soft">
          <h2 className="text-lg font-bold text-slate-900">How it works</h2>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
            <li>1. Enter a position title and all candidate names.</li>
            <li>2. Lock the list and enter one ballot at a time from the physical slips.</li>
            <li>3. Use unique ranks to capture each voter&apos;s preferences.</li>
            <li>4. Finish to calculate IRV results and print a clean report.</li>
          </ul>
        </aside>
      </section>
    </div>
  );

  const renderEntryPhase = () => (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-slate-200 bg-white/95 p-6 shadow-soft">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-500">Data Entry</p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-950 sm:text-4xl">{lockedPositionTitle}</h1>
            <p className="mt-2 text-sm text-slate-600">Enter a single ballot at a time in rank order.</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="rounded-2xl bg-slate-950 px-4 py-3 text-white">
              <div className="text-xs uppercase tracking-[0.22em] text-slate-300">Total Ballots Entered</div>
              <div className="mt-1 text-2xl font-extrabold">{ballots.length}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-soft">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Current ballot</h2>
            <p className="text-sm text-slate-500">Assign ranks using each number once. Leave a candidate blank if not ranked.</p>
          </div>
          <div className="rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
            {candidateCount} candidates
          </div>
        </div>

        <div className="mt-5 grid gap-3">
          {lockedCandidates.map((candidate) => (
            <div key={candidate.id} className="grid items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-[1fr_auto]">
              <div>
                <div className="text-base font-semibold text-slate-950">{candidate.name}</div>
                <div className="text-sm text-slate-500">Rank the slip exactly as marked.</div>
              </div>
              <label className="flex items-center gap-3 sm:justify-end">
                <span className="text-sm font-semibold text-slate-600">Rank</span>
                <select
                  value={currentRanks[candidate.id] ?? ''}
                  onChange={(event) =>
                    setCurrentRanks((previousRanks) => ({
                      ...previousRanks,
                      [candidate.id]: event.target.value,
                    }))
                  }
                  className="min-w-[120px] rounded-xl border border-slate-300 bg-white px-3 py-2 text-base font-semibold text-slate-950 outline-none transition focus:border-slate-950"
                >
                  <option value="">Blank</option>
                  {Array.from({ length: candidateCount }, (_, index) => index + 1).map((rank) => (
                    <option key={rank} value={rank}>
                      {getRankLabel(rank)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>

        {entryError ? (
          <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700" role="alert">
            {entryError}
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={submitBallot}
            className="inline-flex flex-1 items-center justify-center rounded-2xl border border-slate-300 bg-white px-5 py-4 text-base font-bold text-slate-900 transition hover:border-slate-950"
          >
            Submit Ballot &amp; Next
          </button>
          <button
            type="button"
            onClick={finishAndCalculate}
            className="inline-flex flex-1 items-center justify-center rounded-2xl bg-emerald-600 px-5 py-4 text-base font-bold text-white transition hover:bg-emerald-500"
          >
            Finish &amp; Calculate Results
          </button>
        </div>
      </section>
    </div>
  );

  const renderPlacementCard = (entry) => {
    const placeLabel = ordinalLabel(entry.place);
    const isWinner = entry.place === 1;
    const accentClasses = isWinner ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50';
    const badgeClasses = isWinner ? 'bg-emerald-600 text-white' : 'bg-slate-950 text-white';

    return (
      <article key={`${entry.place}-${entry.candidate.id}`} className={`rounded-[1.75rem] border p-5 ${accentClasses}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className={`inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-[0.2em] ${badgeClasses}`}>
              {placeLabel}
            </div>
            <h3 className="mt-3 text-2xl font-extrabold text-slate-950">{entry.candidate.name}</h3>
          </div>
          <div className="text-right">
            <div className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-500">Votes</div>
            <div className="mt-1 text-3xl font-extrabold text-slate-950">{entry.votes}</div>
          </div>
        </div>
      </article>
    );
  };

  const renderResultsPhase = () => (
    <div className="space-y-6 printable-report">
      <section className="rounded-[2rem] border border-slate-200 bg-white/95 p-6 shadow-soft">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-500">Results</p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-slate-950 sm:text-4xl">{lockedPositionTitle}</h1>
            <p className="mt-2 text-sm text-slate-600">Instant runoff results ready for printing.</p>
          </div>

          <div className="no-print flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => window.print()}
              className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-bold text-white transition hover:bg-slate-800"
            >
              Print Report
            </button>
            <button
              type="button"
              onClick={resetToSetup}
              className="rounded-2xl border border-slate-300 bg-white px-5 py-3 text-sm font-bold text-slate-900 transition hover:border-slate-950"
            >
              Start New Tally
            </button>
          </div>
        </div>
      </section>

      {calculation?.isTieStop ? (
        <section className="rounded-[2rem] border border-amber-200 bg-amber-50 p-5 text-amber-900" role="alert">
          <div className="text-sm font-bold uppercase tracking-[0.2em]">Tie alert</div>
          <p className="mt-2 text-base leading-7">{calculation.tieMessage}</p>
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        {standings.slice(0, 3).map((entry) => renderPlacementCard(entry))}
        {standings.length < 3
          ? Array.from({ length: 3 - standings.length }, (_, index) => (
              <article key={`empty-${index}`} className="rounded-[1.75rem] border border-dashed border-slate-300 bg-white/60 p-5 text-slate-400">
                <div className="text-sm font-bold uppercase tracking-[0.2em]">Pending</div>
                <div className="mt-3 text-xl font-semibold">No additional placement available</div>
              </article>
            ))
          : null}
      </section>

      <section className="rounded-[2rem] border border-slate-200 bg-white p-6 shadow-soft">
        <h2 className="text-lg font-bold text-slate-900">Round breakdown</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full border-separate border-spacing-0">
            <thead>
              <tr className="text-left text-xs uppercase tracking-[0.2em] text-slate-500">
                <th className="border-b border-slate-200 pb-3 pr-4">Round</th>
                <th className="border-b border-slate-200 pb-3 pr-4">Active candidates</th>
                <th className="border-b border-slate-200 pb-3 pr-4">Votes counted</th>
                <th className="border-b border-slate-200 pb-3 pr-4">Totals</th>
              </tr>
            </thead>
            <tbody>
              {calculation?.roundSummaries.map((roundSummary) => (
                <tr key={roundSummary.roundNumber} className="align-top text-sm text-slate-700">
                  <td className="border-b border-slate-100 py-4 pr-4 font-bold text-slate-950">{roundSummary.roundNumber}</td>
                  <td className="border-b border-slate-100 py-4 pr-4">
                    <div className="flex flex-wrap gap-2">
                      {roundSummary.activeCandidateIds.map((candidateId) => (
                        <span key={candidateId} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                          {calculation.candidateById[candidateId].name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="border-b border-slate-100 py-4 pr-4 font-semibold text-slate-950">{roundSummary.activeBallotCount}</td>
                  <td className="border-b border-slate-100 py-4 pr-4">
                    <div className="flex flex-wrap gap-2">
                      {roundSummary.activeCandidateIds.map((candidateId) => (
                        <span key={`${roundSummary.roundNumber}-${candidateId}`} className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                          {calculation.candidateById[candidateId].name}: {roundSummary.voteCounts[candidateId]}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="no-print rounded-[2rem] border border-slate-200 bg-slate-950 p-6 text-white">
        <div className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-400">Ballots entered</div>
        <div className="mt-2 text-4xl font-extrabold">{ballots.length}</div>
      </section>
    </div>
  );

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(15,23,42,0.08),_transparent_32%),radial-gradient(circle_at_top_right,_rgba(16,185,129,0.08),_transparent_24%),linear-gradient(180deg,_#f8fafc_0%,_#eef2ff_100%)] px-4 py-6 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between gap-4 no-print">
          <div className="text-sm font-semibold uppercase tracking-[0.28em] text-slate-500">Easy Vote</div>
          <div className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 shadow-sm">
            Client-side only
          </div>
        </div>

        {phase === 'setup' ? renderSetupPhase() : null}
        {phase === 'entry' ? renderEntryPhase() : null}
        {phase === 'results' ? renderResultsPhase() : null}
      </div>
    </main>
  );
};

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);