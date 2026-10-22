import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

import {
  BALLOT_FORMAL,
  BALLOT_INFORMAL,
  BALLOT_VOIDED,
  DEFAULT_ELECTION_TYPE,
  ELECTION_TYPES,
  FLAG_DESCRIPTIONS,
  OUTCOME_ELECTED,
  OUTCOME_NO_BALLOTS,
  OUTCOME_REFERRAL,
  canonicalRecord,
  classifyBallot,
  digestRecord,
  majorityDisclosure,
  runCount,
} from './counting.js';
import { buildCountReport } from './report.js';

/* ------------------------------------------------------------------ *
 * Session persistence
 *
 * A count may run for an hour across hundreds of paper slips. Losing the
 * transcription to a stray refresh or a flat battery would mean starting over,
 * so the session is written to local storage after every change and restored
 * on load. Nothing leaves the machine.
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'easy-vote/session/v2';

const emptySession = () => ({
  phase: 'setup',
  positionTitle: '',
  electionTypeId: DEFAULT_ELECTION_TYPE,
  returningOfficer: '',
  scrutineers: '',
  candidates: [createCandidate(), createCandidate()],
  ballots: [],
});

function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createCandidate(name = '') {
  return { id: createId(), name };
}

const loadSession = () => {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return emptySession();
    }

    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed?.candidates) || !Array.isArray(parsed?.ballots)) {
      return emptySession();
    }

    return { ...emptySession(), ...parsed };
  } catch {
    return emptySession();
  }
};

const downloadFile = (data, fileName, mimeType) => {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Give the browser a moment to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const STATUS_STYLES = {
  [BALLOT_FORMAL]: 'bg-[#e8f3e4] text-[#2a4a1f]',
  [BALLOT_INFORMAL]: 'bg-[#fcd703]/35 text-[#2c2010]',
  [BALLOT_VOIDED]: 'bg-[#2c2010] text-[#fffdf5]',
};

const STATUS_LABELS = {
  [BALLOT_FORMAL]: 'Formal',
  [BALLOT_INFORMAL]: 'Informal',
  [BALLOT_VOIDED]: 'Voided',
};

const card = 'rounded-[2rem] border border-[#c87820]/25 bg-white p-6 shadow-soft';
const labelClass = 'block text-sm font-semibold text-[#2c2010]';
const inputClass =
  'mt-2 w-full rounded-2xl border border-[#d48020]/40 bg-[#fbf6dc] px-4 py-3 text-base text-[#1a1a1a] outline-none transition placeholder:text-[#b09060] focus:border-[#c87820] focus:bg-white';
const primaryButton =
  'inline-flex items-center justify-center rounded-2xl bg-[#1a1a1a] px-5 py-4 text-base font-bold text-[#fffdf5] transition hover:bg-[#2c2010] disabled:cursor-not-allowed disabled:opacity-40';
const secondaryButton =
  'inline-flex items-center justify-center rounded-2xl border border-[#c87820]/35 bg-white px-5 py-3 text-sm font-bold text-[#1a1a1a] transition hover:border-[#c87820] hover:bg-[#f5e060] disabled:cursor-not-allowed disabled:opacity-40';

const Pill = ({ children, className = '' }) => (
  <span className={`rounded-full px-3 py-1 text-xs font-semibold ${className}`}>{children}</span>
);

/* ------------------------------------------------------------------ *
 * Application
 * ------------------------------------------------------------------ */

const App = () => {
  const [session, setSession] = useState(loadSession);
  const [draftMarks, setDraftMarks] = useState({});
  const [editingSerial, setEditingSerial] = useState(null);
  const [setupError, setSetupError] = useState('');
  const [notice, setNotice] = useState('');
  const rankInputRefs = useRef([]);
  const fileInputRef = useRef(null);

  const { phase, positionTitle, electionTypeId, returningOfficer, scrutineers, candidates, ballots } = session;

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Storage may be unavailable (private browsing, quota). The count still
      // works; it simply will not survive a reload.
    }
  }, [session]);

  const update = (changes) => setSession((previous) => ({ ...previous, ...changes }));

  const namedCandidates = useMemo(
    () => candidates.filter((candidate) => candidate.name.trim().length > 0),
    [candidates],
  );

  /**
   * The result is derived from the ledger on every render rather than captured
   * when a button is pressed, so what is displayed can never be a stale
   * snapshot of an earlier set of ballots.
   */
  const result = useMemo(() => {
    if (namedCandidates.length < 2) {
      return null;
    }
    return runCount({ candidates: namedCandidates, ballots, electionTypeId });
  }, [namedCandidates, ballots, electionTypeId]);

  const record = useMemo(() => {
    if (!result) {
      return null;
    }
    return canonicalRecord({ positionTitle, electionTypeId, candidates: namedCandidates, ballots });
  }, [result, positionTitle, electionTypeId, namedCandidates, ballots]);

  const digest = useMemo(() => (record ? digestRecord(record) : null), [record]);

  /**
   * Derived from the highest serial present rather than the ledger length, so
   * an imported session can never produce two slips with the same number.
   */
  const nextSerial = useMemo(
    () => ballots.reduce((highest, entry) => Math.max(highest, entry.serial), 0) + 1,
    [ballots],
  );

  const draftClassification = useMemo(
    () => classifyBallot({ serial: 0, marks: draftMarks }, namedCandidates),
    [draftMarks, namedCandidates],
  );

  const showNotice = (message) => {
    setNotice(message);
    setTimeout(() => setNotice((current) => (current === message ? '' : current)), 6000);
  };

  /* ---------------- setup ---------------- */

  const startTallying = () => {
    const trimmedTitle = positionTitle.trim();
    const prepared = candidates
      .map((candidate) => ({ ...candidate, name: candidate.name.trim() }))
      .filter((candidate) => candidate.name.length > 0);
    const uniqueNames = new Set(prepared.map((candidate) => candidate.name.toLowerCase()));

    if (!trimmedTitle) {
      setSetupError('Enter the position being counted.');
      return;
    }

    if (prepared.length < 2) {
      setSetupError('A preferential count needs at least two candidates.');
      return;
    }

    if (uniqueNames.size !== prepared.length) {
      setSetupError('Two candidates have the same name. Distinguish them before counting.');
      return;
    }

    setSetupError('');
    setDraftMarks({});
    setEditingSerial(null);
    update({ phase: 'entry', positionTitle: trimmedTitle, candidates: prepared });
  };

  const discardEverything = () => {
    const confirmed = window.confirm(
      ballots.length > 0
        ? `This permanently discards all ${ballots.length} transcribed ballot(s) and starts a new count. Export the report first if you have not already. Continue?`
        : 'Start a new count?',
    );

    if (!confirmed) {
      return;
    }

    setDraftMarks({});
    setEditingSerial(null);
    setSetupError('');
    setSession(emptySession());
  };

  /* ---------------- ballot entry ---------------- */

  const focusRank = (index) => {
    const input = rankInputRefs.current[index];
    if (input) {
      input.focus();
      input.select?.();
    }
  };

  const setMark = (candidateId, value) => {
    setDraftMarks((previous) => ({ ...previous, [candidateId]: value.replace(/[^0-9]/g, '').slice(0, 2) }));
  };

  const clearDraft = () => {
    setDraftMarks({});
    setEditingSerial(null);
    requestAnimationFrame(() => focusRank(0));
  };

  const commitBallot = ({ informal = false } = {}) => {
    const marks = Object.fromEntries(
      Object.entries(draftMarks).filter(([, value]) => String(value).trim() !== ''),
    );

    if (!informal && Object.keys(marks).length === 0) {
      showNotice('Nothing is marked on this slip. Record it as informal if the slip really is blank.');
      return;
    }

    if (editingSerial === null) {
      update({ ballots: [...ballots, { serial: nextSerial, marks, informal, voided: false }] });
      showNotice(`Slip ${nextSerial} recorded.`);
    } else {
      update({
        ballots: ballots.map((ballot) =>
          ballot.serial === editingSerial ? { ...ballot, marks, informal } : ballot,
        ),
      });
      showNotice(`Slip ${editingSerial} amended.`);
    }

    clearDraft();
  };

  const loadForEditing = (serial) => {
    const ballot = ballots.find((entry) => entry.serial === serial);
    if (!ballot) {
      return;
    }

    setEditingSerial(serial);
    setDraftMarks(Object.fromEntries(Object.entries(ballot.marks).map(([id, value]) => [id, String(value)])));
    update({ phase: 'entry' });
    requestAnimationFrame(() => focusRank(0));
  };

  /**
   * Entries are voided rather than deleted. Serial numbers stay contiguous and
   * the ledger keeps a record that the slip was seen and set aside, which is
   * what makes a reconciliation meaningful.
   */
  const toggleVoid = (serial) => {
    const ballot = ballots.find((entry) => entry.serial === serial);
    if (!ballot) {
      return;
    }

    if (!ballot.voided) {
      const reason = window.confirm(
        `Void slip ${serial}? It stays in the ledger and in the report, marked as voided, but takes no part in the count.`,
      );
      if (!reason) {
        return;
      }
    }

    update({
      ballots: ballots.map((entry) => (entry.serial === serial ? { ...entry, voided: !entry.voided } : entry)),
    });

    if (editingSerial === serial) {
      clearDraft();
    }
  };

  const handleRankKeyDown = (event, index) => {
    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (index < namedCandidates.length - 1) {
        focusRank(index + 1);
      } else {
        commitBallot();
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (index > 0) {
        focusRank(index - 1);
      }
    }
  };

  /* ---------------- exports ---------------- */

  const downloadPdf = () => {
    if (!result) {
      return;
    }

    const report = buildCountReport({
      result,
      positionTitle,
      ballots,
      returningOfficer,
      scrutineers,
      generatedAt: new Date(),
    });

    downloadFile(report.bytes, report.fileName, 'application/pdf');
    showNotice(`PDF report downloaded. Ballot record digest ${report.digest.hex.slice(0, 16)}...`);
  };

  const downloadRecord = () => {
    if (!record || !digest) {
      return;
    }

    const safeTitle = positionTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'position';
    downloadFile(record, `uec-ballot-record-${safeTitle}.txt`, 'text/plain;charset=utf-8');
    showNotice('Ballot record downloaded. Run sha256sum on it to check the digest in the PDF.');
  };

  const downloadCsv = () => {
    if (!result) {
      return;
    }

    const header = ['Slip', 'Status', 'Flags', ...namedCandidates.map((candidate) => candidate.name), 'Counted as'];
    const rows = result.classifiedBallots.map((ballot) => [
      ballot.serial,
      STATUS_LABELS[ballot.status],
      ballot.flags.join('; '),
      ...namedCandidates.map((candidate) => ballot.marks[candidate.id] ?? ''),
      ballot.preferences.map((id, index) => `${index + 1}. ${result.candidateById[id].name}`).join(' | '),
    ]);

    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    const safeTitle = positionTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'position';
    downloadFile(`${csv}\r\n`, `uec-ballot-ledger-${safeTitle}.csv`, 'text/csv;charset=utf-8');
  };

  const downloadSession = () => {
    const payload = JSON.stringify({ ...session, savedAt: new Date().toISOString() }, null, 2);
    const safeTitle = positionTitle.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'position';
    downloadFile(payload, `uec-session-${safeTitle}.json`, 'application/json');
  };

  const importSession = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));

        if (!Array.isArray(parsed?.candidates) || !Array.isArray(parsed?.ballots)) {
          showNotice('That file is not an easy-vote session.');
          return;
        }

        if (
          ballots.length > 0 &&
          !window.confirm(`This replaces the current count of ${ballots.length} ballot(s). Continue?`)
        ) {
          return;
        }

        setDraftMarks({});
        setEditingSerial(null);
        setSession({ ...emptySession(), ...parsed, phase: 'results' });
        showNotice('Session loaded. Verify the ballot record digest against the original report.');
      } catch {
        showNotice('That file could not be read as JSON.');
      }
    };
    reader.readAsText(file);
  };

  /* ---------------- rendering ---------------- */

  const electionType = ELECTION_TYPES[electionTypeId] ?? ELECTION_TYPES[DEFAULT_ELECTION_TYPE];

  const renderSetup = () => (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-[#c87820]/30 bg-white/90 p-6 shadow-soft backdrop-blur">
        <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#c87820]">Setup</p>
        <h1 className="mt-3 text-3xl font-extrabold tracking-tight text-[#1a1a1a] sm:text-4xl">
          UEC preferential count
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-7 text-[#2c2010]">
          Transcribes paper ballots and counts them under the UEC Constitution (7 August 2026). The count never
          breaks a tie: where the Constitution reserves that decision to the Committee, the count stops and says so.
        </p>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className={card}>
          <label className={labelClass} htmlFor="position-title">
            Position being counted
          </label>
          <input
            id="position-title"
            value={positionTitle}
            onChange={(event) => update({ positionTitle: event.target.value })}
            placeholder="President"
            className={inputClass}
          />

          <fieldset className="mt-6">
            <legend className={labelClass}>Type of ballot</legend>
            <div className="mt-3 space-y-3">
              {Object.values(ELECTION_TYPES).map((type) => (
                <label
                  key={type.id}
                  className={`flex cursor-pointer gap-3 rounded-2xl border p-4 transition ${
                    electionTypeId === type.id
                      ? 'border-[#c87820] bg-[#fbf6dc]'
                      : 'border-[#d48020]/25 bg-white hover:border-[#c87820]/60'
                  }`}
                >
                  <input
                    type="radio"
                    name="election-type"
                    value={type.id}
                    checked={electionTypeId === type.id}
                    onChange={() => update({ electionTypeId: type.id })}
                    className="mt-1 h-4 w-4 accent-[#c87820]"
                  />
                  <span>
                    <span className="block text-base font-bold text-[#1a1a1a]">{type.label}</span>
                    <span className="mt-1 block text-sm text-[#2c2010]">
                      Counted under {type.countAuthority}. Ties resolved under {type.tieAuthority}.
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelClass} htmlFor="returning-officer">
                Returning Officer
              </label>
              <input
                id="returning-officer"
                value={returningOfficer}
                onChange={(event) => update({ returningOfficer: event.target.value })}
                placeholder="Name for the report"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor="scrutineers">
                Scrutineers present
              </label>
              <input
                id="scrutineers"
                value={scrutineers}
                onChange={(event) => update({ scrutineers: event.target.value })}
                placeholder="Names, comma separated"
                className={inputClass}
              />
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-[#1a1a1a]">Candidates</h2>
              <p className="text-sm text-[#2c2010]">Enter every candidate on the ballot, in nomination order.</p>
            </div>
            <button
              type="button"
              onClick={() => update({ candidates: [...candidates, createCandidate()] })}
              className="rounded-full border border-[#c87820]/40 bg-white px-4 py-2 text-sm font-semibold text-[#2c2010] transition hover:border-[#c87820] hover:bg-[#f5e060]"
            >
              Add candidate
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {candidates.map((candidate, index) => (
              <div
                key={candidate.id}
                className="flex items-center gap-3 rounded-2xl border border-[#d48020]/25 bg-[#fbf6dc] p-3"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#2c2010] text-sm font-bold text-[#fffdf5]">
                  {index + 1}
                </div>
                <input
                  value={candidate.name}
                  onChange={(event) =>
                    update({
                      candidates: candidates.map((entry) =>
                        entry.id === candidate.id ? { ...entry, name: event.target.value } : entry,
                      ),
                    })
                  }
                  placeholder={`Candidate ${index + 1}`}
                  className="min-w-0 flex-1 rounded-xl border border-[#d48020]/40 bg-white px-4 py-3 text-base outline-none transition placeholder:text-[#b09060] focus:border-[#c87820]"
                />
                <button
                  type="button"
                  onClick={() =>
                    candidates.length > 2 &&
                    update({ candidates: candidates.filter((entry) => entry.id !== candidate.id) })
                  }
                  disabled={candidates.length <= 2}
                  className="rounded-xl px-3 py-2 text-sm font-semibold text-[#c87820] transition hover:bg-[#f5e060] hover:text-[#1a1a1a] disabled:opacity-30"
                  aria-label={`Remove candidate ${index + 1}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {setupError ? (
            <div
              className="mt-4 rounded-2xl border border-[#d48020]/40 bg-[#fcd703]/20 px-4 py-3 text-sm font-semibold text-[#2c2010]"
              role="alert"
            >
              {setupError}
            </div>
          ) : null}

          <button type="button" onClick={startTallying} className={`${primaryButton} mt-6 w-full`}>
            Lock candidates and begin transcribing
          </button>
        </div>

        <aside className="space-y-4">
          <div className="rounded-[2rem] border border-dashed border-[#c87820]/35 bg-white/70 p-6 text-[#2c2010] shadow-soft">
            <h2 className="text-lg font-bold text-[#1a1a1a]">What this produces</h2>
            <ul className="mt-4 space-y-3 text-sm leading-6">
              <li>A PDF report with first preference votes for every candidate, every round of the count, and the full ballot ledger.</li>
              <li>A ballot record file whose SHA-256 is printed in the report, so any later change to the ledger is detectable.</li>
              <li>A CSV of every slip as transcribed, for independent re-counting in a spreadsheet.</li>
            </ul>
          </div>

          <div className="rounded-[2rem] border border-[#d48020]/25 bg-[#fbf6dc] p-6 text-sm leading-6 text-[#2c2010]">
            <h2 className="text-base font-bold text-[#1a1a1a]">Rules applied</h2>
            <p className="mt-3">
              A candidate is elected on more than 50% of the votes counted, with the preferences of excluded
              candidates distributed in order ({electionType.countAuthority}).
            </p>
            <p className="mt-2">
              Where the count ties, it halts and reports the referral required by {electionType.tieAuthority}. No
              tie-break is invented.
            </p>
          </div>

          <div className="rounded-[2rem] border border-[#d48020]/25 bg-white p-6">
            <h2 className="text-base font-bold text-[#1a1a1a]">Resume a count</h2>
            <p className="mt-2 text-sm text-[#2c2010]">
              Load a session file exported earlier. Entry in progress is saved automatically in this browser.
            </p>
            <button type="button" onClick={() => fileInputRef.current?.click()} className={`${secondaryButton} mt-4`}>
              Load session file
            </button>
          </div>
        </aside>
      </section>
    </div>
  );

  const renderEntry = () => (
    <div className="space-y-6">
      <section className="rounded-[2rem] border border-[#c87820]/25 bg-white/95 p-6 shadow-soft">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#c87820]">Transcription</p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-[#1a1a1a] sm:text-4xl">
              {positionTitle}
            </h1>
            <p className="mt-2 text-sm text-[#2c2010]">
              {electionType.label} &middot; counted under {electionType.countAuthority}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="rounded-2xl bg-[#2c2010] px-4 py-3 text-[#fffdf5]">
              <div className="text-xs uppercase tracking-[0.22em] text-[#f5e060]">Slips in ledger</div>
              <div className="mt-1 text-2xl font-extrabold">{ballots.length}</div>
            </div>
            {result ? (
              <>
                <div className="rounded-2xl border border-[#d48020]/30 bg-white px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.22em] text-[#c87820]">Formal</div>
                  <div className="mt-1 text-2xl font-extrabold">{result.reconciliation.formal}</div>
                </div>
                <div className="rounded-2xl border border-[#d48020]/30 bg-white px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.22em] text-[#c87820]">Informal</div>
                  <div className="mt-1 text-2xl font-extrabold">{result.reconciliation.informal}</div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-[#1a1a1a]">
              {editingSerial === null ? `Slip ${nextSerial}` : `Amending slip ${editingSerial}`}
            </h2>
            <p className="text-sm text-[#2c2010]">
              Type the number written against each candidate. Leave blank where the slip is blank.
            </p>
          </div>
          <Pill className="bg-[#fbf6dc] text-[#2c2010]">{namedCandidates.length} candidates</Pill>
        </div>

        <div className="mt-5 grid gap-3">
          {namedCandidates.map((candidate, index) => (
            <div
              key={candidate.id}
              className="grid items-center gap-3 rounded-2xl border border-[#d48020]/20 bg-[#fbf6dc] p-4 sm:grid-cols-[1fr_auto]"
            >
              <div className="text-base font-semibold text-[#1a1a1a]">{candidate.name}</div>
              <label className="flex items-center gap-3 sm:justify-end">
                <span className="text-sm font-semibold text-[#2c2010]">Number</span>
                <input
                  value={draftMarks[candidate.id] ?? ''}
                  onChange={(event) => setMark(candidate.id, event.target.value)}
                  onKeyDown={(event) => handleRankKeyDown(event, index)}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder="-"
                  aria-label={`Preference number for ${candidate.name}`}
                  ref={(element) => {
                    rankInputRefs.current[index] = element;
                  }}
                  className="w-20 rounded-xl border border-[#d48020]/40 bg-white px-3 py-2 text-center text-base font-extrabold outline-none transition placeholder:text-[#b09060] focus:border-[#c87820]"
                />
              </label>
            </div>
          ))}
        </div>

        {/* Live formality feedback, so a problem slip is noticed at the slip and
            not discovered at the end of the count. */}
        <div
          className={`mt-5 rounded-2xl border px-4 py-3 text-sm ${
            draftClassification.status === BALLOT_FORMAL && !draftClassification.requiresReview
              ? 'border-[#2a4a1f]/25 bg-[#e8f3e4] text-[#2a4a1f]'
              : 'border-[#d48020]/40 bg-[#fcd703]/20 text-[#2c2010]'
          }`}
          role="status"
        >
          <div className="font-bold">
            {draftClassification.status === BALLOT_FORMAL
              ? `Will count as formal: ${draftClassification.preferences
                  .map((id, index) => `${index + 1}. ${namedCandidates.find((c) => c.id === id)?.name}`)
                  .join('   ')}`
              : 'Will count as informal. No first preference can be read from this slip.'}
          </div>
          {draftClassification.flags.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {draftClassification.flags.map((flag) => (
                <li key={flag}>{FLAG_DESCRIPTIONS[flag] ?? flag}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button type="button" onClick={() => commitBallot()} className={primaryButton}>
            {editingSerial === null ? 'Record slip' : 'Save amendment'}
          </button>
          <button type="button" onClick={() => commitBallot({ informal: true })} className={secondaryButton}>
            Record as informal
          </button>
          <button type="button" onClick={clearDraft} className={secondaryButton}>
            {editingSerial === null ? 'Clear' : 'Cancel amendment'}
          </button>
          <button type="button" onClick={() => update({ phase: 'results' })} className={secondaryButton}>
            Go to result &amp; reports
          </button>
        </div>

        <p className="mt-4 text-xs text-[#2c2010]/70">
          Enter or the down arrow moves to the next candidate; from the last candidate it records the slip.
        </p>
      </section>

      {renderLedger()}
    </div>
  );

  const renderLedger = () => (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-[#1a1a1a]">Ballot ledger</h2>
          <p className="text-sm text-[#2c2010]">
            Every slip as transcribed. Amend a slip to correct a transcription error; void it to set it aside
            without erasing the record.
          </p>
        </div>
        <Pill className="bg-[#fbf6dc] text-[#2c2010]">{ballots.length} slips</Pill>
      </div>

      <div className="mt-4 grid gap-2">
        {ballots.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-[#d48020]/30 bg-[#fbf6dc] p-4 text-sm text-[#2c2010]">
            No slips transcribed yet.
          </div>
        ) : (
          result?.classifiedBallots
            .slice()
            .reverse()
            .map((classified) => (
              <div
                key={classified.serial}
                className="flex flex-col gap-3 rounded-2xl border border-[#d48020]/20 bg-[#fbf6dc] p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold uppercase tracking-[0.18em] text-[#c87820]">
                      Slip {classified.serial}
                    </span>
                    <Pill className={STATUS_STYLES[classified.status]}>{STATUS_LABELS[classified.status]}</Pill>
                    {classified.requiresReview ? (
                      <Pill className="bg-[#fcd703]/50 text-[#2c2010]">Needs review</Pill>
                    ) : null}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-2">
                    {classified.preferences.length > 0 ? (
                      classified.preferences.map((candidateId, index) => (
                        <Pill key={candidateId} className="bg-white text-[#2c2010]">
                          {index + 1}. {result.candidateById[candidateId].name}
                        </Pill>
                      ))
                    ) : (
                      <span className="text-sm text-[#2c2010]">Takes no part in the count.</span>
                    )}
                  </div>

                  {classified.flags.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-xs text-[#2c2010]/80">
                      {classified.flags.map((flag) => (
                        <li key={flag}>{FLAG_DESCRIPTIONS[flag] ?? flag}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => loadForEditing(classified.serial)}
                    className="rounded-xl border border-[#c87820]/35 bg-white px-4 py-2 text-sm font-bold transition hover:border-[#c87820] hover:bg-[#f5e060]"
                  >
                    Amend
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleVoid(classified.serial)}
                    className="rounded-xl border border-[#2c2010]/30 bg-white px-4 py-2 text-sm font-bold transition hover:bg-[#2c2010] hover:text-[#fffdf5]"
                  >
                    {classified.status === BALLOT_VOIDED ? 'Restore' : 'Void'}
                  </button>
                </div>
              </div>
            ))
        )}
      </div>
    </section>
  );

  const renderOutcome = () => {
    if (!result) {
      return null;
    }

    const { outcome } = result;

    if (outcome.status === OUTCOME_ELECTED) {
      return (
        <section className="rounded-[2rem] border-2 border-[#2a4a1f]/30 bg-[#e8f3e4] p-6">
          <div className="text-xs font-bold uppercase tracking-[0.22em] text-[#2a4a1f]">Result: candidate elected</div>
          <h2 className="mt-3 text-4xl font-extrabold text-[#1a1a1a]">
            {result.candidateById[outcome.winnerId].name}
          </h2>
          <p className="mt-3 text-base leading-7 text-[#2a4a1f]">{outcome.detail}</p>
          <p className="mt-2 text-sm text-[#2a4a1f]/80">Determined under {outcome.authority}.</p>
          {outcome.immaterialTies > 0 ? (
            <p className="mt-3 rounded-2xl bg-white/70 px-4 py-3 text-sm text-[#2c2010]">
              {outcome.immaterialTies} tie(s) for exclusion arose. Every lawful exclusion order was followed through
              and all produced this same result, so no referral is required. The detail is in the PDF report.
            </p>
          ) : null}
        </section>
      );
    }

    if (outcome.status === OUTCOME_REFERRAL) {
      return (
        <section className="rounded-[2rem] border-2 border-[#8c1d1d]/40 bg-[#fcd703]/20 p-6" role="alert">
          <div className="text-xs font-bold uppercase tracking-[0.22em] text-[#8c1d1d]">
            Result: no candidate elected by this count
          </div>
          <h2 className="mt-3 text-2xl font-extrabold text-[#1a1a1a]">{outcome.headline}</h2>
          <p className="mt-3 text-base leading-7 text-[#2c2010]">{outcome.detail}</p>

          <div className="mt-4 rounded-2xl bg-white p-4">
            <div className="text-sm font-bold text-[#1a1a1a]">Candidates affected</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {outcome.candidateIds.map((candidateId) => (
                <Pill key={candidateId} className="bg-[#fbf6dc] text-[#2c2010]">
                  {result.candidateById[candidateId].name}
                </Pill>
              ))}
            </div>
          </div>

          <div className="mt-4 rounded-2xl bg-white p-4">
            <div className="text-sm font-bold text-[#1a1a1a]">Required next step under {outcome.authority}</div>
            <p className="mt-2 text-sm leading-6 text-[#2c2010]">{outcome.instruction}</p>
          </div>

          <p className="mt-4 text-sm font-bold text-[#8c1d1d]">
            This program will not break the tie. The Constitution reserves that decision to the Committee.
          </p>
        </section>
      );
    }

    return (
      <section className="rounded-[2rem] border-2 border-[#8c1d1d]/40 bg-[#fcd703]/20 p-6" role="alert">
        <div className="text-xs font-bold uppercase tracking-[0.22em] text-[#8c1d1d]">Result: no count possible</div>
        <h2 className="mt-3 text-2xl font-extrabold text-[#1a1a1a]">{outcome.headline}</h2>
        <p className="mt-3 text-base leading-7 text-[#2c2010]">{outcome.detail}</p>
      </section>
    );
  };

  const renderResults = () => {
    if (!result) {
      return (
        <section className={card}>
          <h1 className="text-2xl font-extrabold">Nothing to count yet</h1>
          <p className="mt-2 text-sm text-[#2c2010]">Enter at least two candidates to begin.</p>
          <button type="button" onClick={() => update({ phase: 'setup' })} className={`${secondaryButton} mt-4`}>
            Back to setup
          </button>
        </section>
      );
    }

    const disclosure = majorityDisclosure(result);
    const failedChecks = result.checks.filter((check) => !check.pass);

    return (
      <div className="space-y-6">
        <section className="rounded-[2rem] border border-[#c87820]/25 bg-white/95 p-6 shadow-soft">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.28em] text-[#c87820]">Result</p>
              <h1 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-4xl">{positionTitle}</h1>
              <p className="mt-2 text-sm text-[#2c2010]">
                {electionType.label} &middot; {electionType.countAuthority} &middot; UEC Constitution, 7 August 2026
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={downloadPdf} className={primaryButton}>
                Download PDF report
              </button>
              <button type="button" onClick={() => update({ phase: 'entry' })} className={secondaryButton}>
                Back to transcription
              </button>
            </div>
          </div>
        </section>

        {failedChecks.length > 0 ? (
          <section className="rounded-[2rem] border-2 border-[#8c1d1d] bg-[#8c1d1d]/10 p-6" role="alert">
            <h2 className="text-lg font-extrabold text-[#8c1d1d]">Arithmetic check failed — do not rely on this count</h2>
            <ul className="mt-3 space-y-2 text-sm text-[#2c2010]">
              {failedChecks.map((check) => (
                <li key={check.label}>
                  <strong>{check.label}:</strong> {check.detail}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {renderOutcome()}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Slips in ledger', result.reconciliation.entriesInLedger],
            ['Formal (counted)', result.reconciliation.formal],
            ['Informal', result.reconciliation.informal],
            ['Voided', result.reconciliation.voided],
          ].map(([label, value]) => (
            <div key={label} className="rounded-[1.5rem] border border-[#d48020]/25 bg-white p-5">
              <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[#c87820]">{label}</div>
              <div className="mt-2 text-3xl font-extrabold">{value}</div>
            </div>
          ))}
        </section>

        {result.firstPreferences ? (
          <section className={card}>
            <h2 className="text-lg font-bold">First preference votes</h2>
            <p className="mt-2 text-sm text-[#2c2010]">
              Number 1 marks on formal ballots. {result.firstPreferences.majorityThreshold} vote(s) of{' '}
              {result.firstPreferences.totalFormal} were needed to exceed 50% and be elected outright.
            </p>

            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-[0.2em] text-[#2c2010]">
                    <th className="border-b border-[#d48020]/25 pb-3 pr-4">Candidate</th>
                    <th className="border-b border-[#d48020]/25 pb-3 pr-4 text-right">1st preferences</th>
                    <th className="border-b border-[#d48020]/25 pb-3 pr-4 text-right">Share of formal</th>
                    <th className="border-b border-[#d48020]/25 pb-3 text-right">Over 50%?</th>
                  </tr>
                </thead>
                <tbody>
                  {namedCandidates
                    .map((candidate) => ({
                      candidate,
                      votes: result.firstPreferences.counts[candidate.id] ?? 0,
                    }))
                    .sort((left, right) => right.votes - left.votes)
                    .map(({ candidate, votes }) => (
                      <tr key={candidate.id}>
                        <td className="border-b border-[#f5e060]/60 py-3 pr-4 font-semibold">{candidate.name}</td>
                        <td className="border-b border-[#f5e060]/60 py-3 pr-4 text-right font-extrabold">{votes}</td>
                        <td className="border-b border-[#f5e060]/60 py-3 pr-4 text-right">
                          {result.firstPreferences.totalFormal === 0
                            ? '-'
                            : `${((votes / result.firstPreferences.totalFormal) * 100).toFixed(1)}%`}
                        </td>
                        <td className="border-b border-[#f5e060]/60 py-3 text-right">
                          {votes >= result.firstPreferences.majorityThreshold ? 'Yes' : 'No'}
                        </td>
                      </tr>
                    ))}
                  <tr>
                    <td className="py-3 pr-4 font-extrabold">Total</td>
                    <td className="py-3 pr-4 text-right font-extrabold">
                      {Object.values(result.firstPreferences.counts).reduce((total, value) => total + value, 0)}
                    </td>
                    <td className="py-3 pr-4" />
                    <td className="py-3" />
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {result.rounds.length > 0 ? (
          <section className={card}>
            <h2 className="text-lg font-bold">Round-by-round count</h2>
            <p className="mt-2 text-sm text-[#2c2010]">
              A dash means the candidate had already been excluded. &ldquo;Excl.&rdquo; marks the candidate excluded
              at the end of that round.
            </p>

            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-[0.2em] text-[#2c2010]">
                    <th className="border-b border-[#d48020]/25 pb-3 pr-4">Candidate</th>
                    {result.rounds.map((round) => (
                      <th key={round.roundNumber} className="border-b border-[#d48020]/25 pb-3 pr-4 text-right">
                        Round {round.roundNumber}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {namedCandidates.map((candidate) => (
                    <tr key={candidate.id}>
                      <td className="border-b border-[#f5e060]/60 py-3 pr-4 font-semibold">{candidate.name}</td>
                      {result.rounds.map((round) => (
                        <td
                          key={round.roundNumber}
                          className="border-b border-[#f5e060]/60 py-3 pr-4 text-right font-extrabold"
                        >
                          {round.continuingIds.includes(candidate.id) ? (
                            <>
                              {round.counts[candidate.id]}
                              {round.excludedId === candidate.id ? (
                                <span className="ml-1 text-xs font-semibold text-[#8c1d1d]">Excl.</span>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-[#b09060]">-</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {[
                    ['Votes counted this round', (round) => round.continuingBallots],
                    ['Ballots exhausted', (round) => round.exhaustedBallots],
                    ['Needed for more than 50%', (round) => round.majorityThreshold],
                  ].map(([label, pick]) => (
                    <tr key={label} className="bg-[#fbf6dc]">
                      <td className="py-3 pr-4 text-sm font-bold">{label}</td>
                      {result.rounds.map((round) => (
                        <td key={round.roundNumber} className="py-3 pr-4 text-right font-semibold">
                          {pick(round)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        {disclosure?.divergent ? (
          <section className="rounded-[2rem] border border-[#d48020]/50 bg-[#fcd703]/15 p-6">
            <h2 className="text-base font-bold uppercase tracking-[0.18em] text-[#2c2010]">Disclosure</h2>
            <p className="mt-3 text-sm leading-6 text-[#2c2010]">
              The elected candidate holds {disclosure.winnerVotes} of the {disclosure.continuingBallots} ballots
              still being counted, which is a majority, but not of all {disclosure.totalFormal} formal ballots cast,
              because {disclosure.exhaustedBallots} ballot(s) were exhausted. This is the ordinary consequence of a
              conventional preferential count where voters do not number every square, and it is recorded in the PDF
              report.
            </p>
          </section>
        ) : null}

        {result.flaggedBallots.length > 0 ? (
          <section className={card}>
            <h2 className="text-lg font-bold">Ballots needing the Returning Officer&rsquo;s attention</h2>
            <p className="mt-2 text-sm text-[#2c2010]">
              {result.flaggedBallots.length} slip(s) departed from clean sequential numbering. Preferences were read
              from 1 upwards and stopped at the first missing or repeated number. All are listed in the PDF report.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {result.flaggedBallots.map((ballot) => (
                <button
                  key={ballot.serial}
                  type="button"
                  onClick={() => loadForEditing(ballot.serial)}
                  className="rounded-full border border-[#d48020]/40 bg-[#fbf6dc] px-4 py-2 text-sm font-semibold transition hover:border-[#c87820] hover:bg-[#f5e060]"
                >
                  Slip {ballot.serial} &middot; {STATUS_LABELS[ballot.status]}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className={card}>
          <h2 className="text-lg font-bold">Audit outputs</h2>
          <p className="mt-2 text-sm text-[#2c2010]">
            The PDF report is the document of record. The ballot record is the file an auditor hashes: running
            <code className="mx-1 rounded bg-[#fbf6dc] px-1">sha256sum</code> over it must reproduce the digest
            printed in the report.
          </p>

          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-[#fbf6dc] p-4">
              <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-[#c87820]">
                Ballot record digest ({digest?.algorithm})
              </dt>
              <dd className="mt-2 break-all font-mono text-xs text-[#1a1a1a]">{digest?.hex}</dd>
            </div>
            <div className="rounded-2xl bg-[#fbf6dc] p-4">
              <dt className="text-xs font-semibold uppercase tracking-[0.2em] text-[#c87820]">Counting rules</dt>
              <dd className="mt-2 text-sm text-[#1a1a1a]">
                {result.rulesVersion}
                <br />
                engine {result.engineVersion}
              </dd>
            </div>
          </dl>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <button type="button" onClick={downloadPdf} className={primaryButton}>
              PDF report
            </button>
            <button type="button" onClick={downloadRecord} className={secondaryButton}>
              Ballot record (.txt)
            </button>
            <button type="button" onClick={downloadCsv} className={secondaryButton}>
              Ledger (.csv)
            </button>
            <button type="button" onClick={downloadSession} className={secondaryButton}>
              Session (.json)
            </button>
          </div>
        </section>

        {renderLedger()}

        <section className="flex flex-wrap gap-3">
          <button type="button" onClick={() => fileInputRef.current?.click()} className={secondaryButton}>
            Load a session file
          </button>
          <button
            type="button"
            onClick={discardEverything}
            className="inline-flex items-center justify-center rounded-2xl border border-[#8c1d1d]/40 bg-white px-5 py-3 text-sm font-bold text-[#8c1d1d] transition hover:bg-[#8c1d1d] hover:text-[#fffdf5]"
          >
            Discard and start a new count
          </button>
        </section>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(252,215,3,0.22),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(196,120,32,0.20),_transparent_24%),linear-gradient(180deg,_#fffdf5_0%,_#fbf6dc_52%,_#f5e060_100%)] px-4 py-6 text-[#1a1a1a] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm font-semibold uppercase tracking-[0.28em] text-[#2c2010]">Easy Vote</div>
          <div className="flex flex-wrap gap-2">
            <Pill className="border border-[#d48020]/30 bg-white text-[#2c2010] shadow-sm">
              Runs entirely in this browser
            </Pill>
            <Pill className="border border-[#d48020]/30 bg-white text-[#2c2010] shadow-sm">
              UEC Constitution, 7 Aug 2026
            </Pill>
          </div>
        </div>

        {notice ? (
          <div
            className="mb-6 rounded-2xl border border-[#c87820]/40 bg-white px-4 py-3 text-sm font-semibold text-[#2c2010] shadow-sm"
            role="status"
          >
            {notice}
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={importSession}
          className="hidden"
        />

        {phase === 'setup' ? renderSetup() : null}
        {phase === 'entry' ? renderEntry() : null}
        {phase === 'results' ? renderResults() : null}
      </div>
    </main>
  );
};

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
