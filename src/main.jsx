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
  OUTCOME_REFERRAL,
  canonicalRecord,
  classifyBallot,
  digestRecord,
  majorityDisclosure,
  runCount,
} from './counting.js';
import { buildCountReport } from './report.js';

/* ================================================================== *
 * Session state and persistence
 *
 * A count may run for an hour across hundreds of paper slips. Losing the
 * transcription to a stray refresh or a flat battery would mean starting
 * again, so the session is written to local storage after every change and
 * restored on load. Nothing leaves the machine.
 * ================================================================== */

const STORAGE_KEY = 'easy-vote/session/v2';

function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createCandidate(name = '') {
  return { id: createId(), name };
}

const emptySession = () => ({
  phase: 'setup',
  positionTitle: '',
  electionTypeId: DEFAULT_ELECTION_TYPE,
  returningOfficer: '',
  scrutineers: '',
  candidates: [createCandidate(), createCandidate()],
  ballots: [],
  fastEntry: false,
});

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

/* ================================================================== *
 * Helpers
 * ================================================================== */

const downloadFile = (data, fileName, mimeType) => {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const safeFileStem = (title) => title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'position';

/**
 * Fast entry: the numbers written down the candidate column, typed as one
 * string. "213" means the first candidate was marked 2, the second 1, the
 * third 3. Commas or spaces separate the marks where there are ten or more
 * candidates, and a dot or dash leaves a candidate unmarked.
 */
const parseFastEntry = (text, candidates) => {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') {
    return {};
  }

  const tokens = /[,\s]/.test(trimmed) ? trimmed.split(/[,\s]+/) : [...trimmed];
  const marks = {};

  candidates.forEach((candidate, index) => {
    const token = (tokens[index] ?? '').trim();
    if (/^[1-9]\d*$/.test(token)) {
      marks[candidate.id] = token;
    }
  });

  return marks;
};

const buildFastEntry = (marks, candidates) =>
  candidates.map((candidate) => marks[candidate.id] || '.').join(candidates.length > 9 ? ',' : '');

/* ================================================================== *
 * Presentation constants
 * ================================================================== */

const STATUS_STYLES = {
  [BALLOT_FORMAL]: 'bg-[#e8f3e4] text-[#2a4a1f]',
  [BALLOT_INFORMAL]: 'bg-[#fcd703]/40 text-[#2c2010]',
  [BALLOT_VOIDED]: 'bg-[#2c2010] text-[#fffdf5]',
};

const STATUS_LABELS = {
  [BALLOT_FORMAL]: 'Formal',
  [BALLOT_INFORMAL]: 'Informal',
  [BALLOT_VOIDED]: 'Voided',
};

const card = 'rounded-[1.75rem] border border-[#c87820]/25 bg-white p-5 shadow-soft sm:p-6';
const labelClass = 'block text-sm font-semibold text-[#2c2010]';
const inputClass =
  'mt-2 w-full rounded-2xl border border-[#d48020]/40 bg-[#fbf6dc] px-4 py-3 text-base outline-none transition placeholder:text-[#b09060] focus:border-[#c87820] focus:bg-white';
const primaryButton =
  'inline-flex min-h-[3.25rem] items-center justify-center gap-2 rounded-2xl bg-[#1a1a1a] px-5 py-3 text-base font-bold text-[#fffdf5] transition hover:bg-[#2c2010] disabled:cursor-not-allowed disabled:opacity-40';
const secondaryButton =
  'inline-flex min-h-[3.25rem] items-center justify-center gap-2 rounded-2xl border border-[#c87820]/40 bg-white px-5 py-3 text-sm font-bold text-[#1a1a1a] transition hover:border-[#c87820] hover:bg-[#f5e060] disabled:cursor-not-allowed disabled:opacity-40';
const dangerButton =
  'inline-flex min-h-[3.25rem] items-center justify-center rounded-2xl border border-[#8c1d1d]/40 bg-white px-5 py-3 text-sm font-bold text-[#8c1d1d] transition hover:bg-[#8c1d1d] hover:text-[#fffdf5]';

const Pill = ({ children, className = '' }) => (
  <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${className}`}>{children}</span>
);

const Stat = ({ label, value, tone = 'light' }) => (
  <div
    className={`rounded-2xl px-4 py-3 ${
      tone === 'dark' ? 'bg-[#2c2010] text-[#fffdf5]' : 'border border-[#d48020]/30 bg-white text-[#1a1a1a]'
    }`}
  >
    <div
      className={`text-[0.65rem] font-semibold uppercase tracking-[0.18em] ${
        tone === 'dark' ? 'text-[#f5e060]' : 'text-[#c87820]'
      }`}
    >
      {label}
    </div>
    <div className="mt-0.5 text-2xl font-extrabold tabular-nums">{value}</div>
  </div>
);

const Section = ({ title, blurb, children, defaultOpen = true, badge = null }) => (
  <details className={card} open={defaultOpen}>
    <summary className="cursor-pointer select-none">
      <span className="text-lg font-bold text-[#1a1a1a]">{title}</span>
      {badge ? <span className="ml-2">{badge}</span> : null}
    </summary>
    {blurb ? <p className="mt-2 text-sm leading-6 text-[#2c2010]">{blurb}</p> : null}
    <div className="mt-4">{children}</div>
  </details>
);

const STEPS = [
  { id: 'setup', label: 'Set up' },
  { id: 'entry', label: 'Transcribe slips' },
  { id: 'results', label: 'Result & reports' },
];

const StepBar = ({ phase, onGo, canLeaveSetup, canReturnToSetup }) => (
  <nav aria-label="Progress" className="flex flex-wrap items-center gap-2">
    {STEPS.map((step, index) => {
      const currentIndex = STEPS.findIndex((entry) => entry.id === phase);
      const isCurrent = step.id === phase;
      const isDone = index < currentIndex;

      const reachable =
        (step.id === 'setup' && canReturnToSetup) ||
        (step.id === 'entry' && canLeaveSetup) ||
        (step.id === 'results' && canLeaveSetup);

      return (
        <React.Fragment key={step.id}>
          {index > 0 ? <span aria-hidden="true" className="text-[#c87820]/50">&rsaquo;</span> : null}
          <button
            type="button"
            onClick={() => reachable && !isCurrent && onGo(step.id)}
            disabled={!reachable || isCurrent}
            aria-current={isCurrent ? 'step' : undefined}
            className={`inline-flex min-h-[2.75rem] items-center gap-2 rounded-full px-3.5 py-2 text-xs font-bold transition sm:min-h-0 sm:py-1.5 ${
              isCurrent
                ? 'bg-[#1a1a1a] text-[#fffdf5]'
                : reachable
                  ? 'bg-white text-[#2c2010] hover:bg-[#f5e060]'
                  : 'bg-white/60 text-[#b09060]'
            } ${!reachable || isCurrent ? 'cursor-default' : ''}`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[0.65rem] ${
                isCurrent ? 'bg-[#f5e060] text-[#1a1a1a]' : isDone ? 'bg-[#2a4a1f] text-white' : 'bg-[#fbf6dc]'
              }`}
            >
              {isDone ? '✓' : index + 1}
            </span>
            {step.label}
          </button>
        </React.Fragment>
      );
    })}
  </nav>
);

/* ================================================================== *
 * Application
 * ================================================================== */

const App = () => {
  const [session, setSession] = useState(loadSession);
  const [draftMarks, setDraftMarks] = useState({});
  const [fastText, setFastText] = useState('');
  const [editingSerial, setEditingSerial] = useState(null);
  const [setupError, setSetupError] = useState('');
  const [notice, setNotice] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [showAllSlips, setShowAllSlips] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);

  const rankInputRefs = useRef([]);
  const fastInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const positionInputRef = useRef(null);

  const { phase, positionTitle, electionTypeId, returningOfficer, scrutineers, candidates, ballots, fastEntry } =
    session;

  const update = (changes) => setSession((previous) => ({ ...previous, ...changes }));

  /* ---------------- persistence ---------------- */

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      setSavedAt(new Date());
    } catch {
      // Storage may be unavailable (private browsing, quota). The count still
      // works; it simply will not survive a reload.
      setSavedAt(null);
    }
  }, [session]);

  /**
   * The session is saved continuously, but a closed tab still interrupts a
   * count in progress, so confirm before leaving.
   */
  useEffect(() => {
    if (ballots.length === 0) {
      return undefined;
    }

    const warn = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [ballots.length]);

  /**
   * Focus is placed by an effect rather than scheduled straight after a state
   * change: the inputs may not exist yet, and React re-attaches refs on every
   * render, so a requestAnimationFrame callback can land on a stale or null
   * ref. Bumping focusRequest re-runs this after the render has committed.
   */
  useEffect(() => {
    if (phase === 'setup') {
      positionInputRef.current?.focus();
      return;
    }

    if (phase !== 'entry') {
      return;
    }

    const target = fastEntry ? fastInputRef.current : rankInputRefs.current[0];
    target?.focus();
    target?.select?.();
  }, [phase, fastEntry, focusRequest]);

  /* ---------------- derived state ---------------- */

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

  const record = useMemo(
    () =>
      result ? canonicalRecord({ positionTitle, electionTypeId, candidates: namedCandidates, ballots }) : null,
    [result, positionTitle, electionTypeId, namedCandidates, ballots],
  );

  const digest = useMemo(() => (record ? digestRecord(record) : null), [record]);

  /** Derived from the highest serial present, so an imported session can never
   *  produce two slips with the same number. */
  const nextSerial = useMemo(
    () => ballots.reduce((highest, entry) => Math.max(highest, entry.serial), 0) + 1,
    [ballots],
  );

  const draftClassification = useMemo(
    () => classifyBallot({ serial: 0, marks: draftMarks }, namedCandidates),
    [draftMarks, namedCandidates],
  );

  const lastSlip = ballots.length > 0 ? ballots[ballots.length - 1] : null;

  const showNotice = (message, tone = 'info') => {
    const entry = { message, tone, key: createId() };
    setNotice(entry);
    setTimeout(() => setNotice((current) => (current?.key === entry.key ? null : current)), 5000);
  };

  /* ---------------- setup ---------------- */

  const beginTranscribing = () => {
    const trimmedTitle = positionTitle.trim();
    const prepared = candidates
      .map((candidate) => ({ ...candidate, name: candidate.name.trim() }))
      .filter((candidate) => candidate.name.length > 0);
    const uniqueNames = new Set(prepared.map((candidate) => candidate.name.toLowerCase()));

    if (!trimmedTitle) {
      setSetupError('Enter the position being counted, for example "President".');
      positionInputRef.current?.focus();
      return;
    }

    if (prepared.length < 2) {
      setSetupError('A preferential count needs at least two candidates with names.');
      return;
    }

    if (uniqueNames.size !== prepared.length) {
      setSetupError('Two candidates have the same name. Distinguish them before counting.');
      return;
    }

    setSetupError('');
    resetDraft();
    update({ phase: 'entry', positionTitle: trimmedTitle, candidates: prepared });
  };

  const discardEverything = () => {
    const confirmed = window.confirm(
      ballots.length > 0
        ? `This permanently discards all ${ballots.length} transcribed slip(s) and starts a new count.\n\nDownload the PDF report first if you have not already.\n\nContinue?`
        : 'Start a new count?',
    );

    if (!confirmed) {
      return;
    }

    resetDraft();
    setSetupError('');
    setSession(emptySession());
  };

  /* ---------------- ballot entry ---------------- */

  const requestFocus = () => setFocusRequest((previous) => previous + 1);

  const resetDraft = () => {
    setDraftMarks({});
    setFastText('');
    setEditingSerial(null);
  };

  const setMark = (candidateId, value) => {
    setDraftMarks((previous) => {
      const next = { ...previous, [candidateId]: value.replace(/[^0-9]/g, '').slice(0, 2) };
      setFastText(buildFastEntry(next, namedCandidates));
      return next;
    });
  };

  const setFast = (value) => {
    setFastText(value);
    setDraftMarks(parseFastEntry(value, namedCandidates));
  };

  const toggleFastEntry = () => {
    const nextFast = !fastEntry;
    update({ fastEntry: nextFast });
    setFastText(buildFastEntry(draftMarks, namedCandidates));
    // The focus effect already keys on fastEntry, so the new field is focused
    // once the switch has rendered.
  };

  const commitBallot = ({ informal = false } = {}) => {
    const marks = Object.fromEntries(
      Object.entries(draftMarks).filter(([, value]) => String(value).trim() !== ''),
    );

    if (!informal && Object.keys(marks).length === 0) {
      showNotice('Nothing is marked on this slip. Use "Record as informal" if the slip really is blank.', 'warn');
      requestFocus();
      return;
    }

    if (editingSerial === null) {
      update({ ballots: [...ballots, { serial: nextSerial, marks, informal, voided: false }] });
      showNotice(`Slip ${nextSerial} recorded.`, 'ok');
    } else {
      update({
        ballots: ballots.map((ballot) =>
          ballot.serial === editingSerial ? { ...ballot, marks, informal } : ballot,
        ),
      });
      showNotice(`Slip ${editingSerial} amended.`, 'ok');
    }

    resetDraft();
    requestFocus();
  };

  /**
   * Undo removes the most recent slip and puts its marks back in the form, so
   * a mistyped entry is corrected in one keystroke rather than hunted down in
   * the ledger. Older slips are amended or voided instead.
   */
  const undoLastSlip = () => {
    if (!lastSlip || editingSerial !== null) {
      return;
    }

    update({ ballots: ballots.slice(0, -1) });
    setDraftMarks(Object.fromEntries(Object.entries(lastSlip.marks).map(([id, value]) => [id, String(value)])));
    setFastText(buildFastEntry(lastSlip.marks, namedCandidates));
    setEditingSerial(null);
    showNotice(`Slip ${lastSlip.serial} removed and put back in the form for correction.`, 'warn');
    requestFocus();
  };

  const loadForEditing = (serial) => {
    const ballot = ballots.find((entry) => entry.serial === serial);
    if (!ballot) {
      return;
    }

    setEditingSerial(serial);
    setDraftMarks(Object.fromEntries(Object.entries(ballot.marks).map(([id, value]) => [id, String(value)])));
    setFastText(buildFastEntry(ballot.marks, namedCandidates));
    update({ phase: 'entry' });
    requestFocus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /**
   * Entries are voided rather than deleted. Serial numbers stay contiguous and
   * the ledger keeps a record that the slip was seen and set aside, which is
   * what makes the reconciliation meaningful.
   */
  const toggleVoid = (serial) => {
    const ballot = ballots.find((entry) => entry.serial === serial);
    if (!ballot) {
      return;
    }

    if (
      !ballot.voided &&
      !window.confirm(
        `Void slip ${serial}?\n\nIt stays in the ledger and in the report, marked as voided, but takes no part in the count.`,
      )
    ) {
      return;
    }

    update({
      ballots: ballots.map((entry) => (entry.serial === serial ? { ...entry, voided: !entry.voided } : entry)),
    });

    if (editingSerial === serial) {
      resetDraft();
    }
  };

  const handleMarkKeyDown = (event, index) => {
    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      event.preventDefault();
      if (index < namedCandidates.length - 1) {
        rankInputRefs.current[index + 1]?.focus();
        rankInputRefs.current[index + 1]?.select?.();
      } else {
        commitBallot();
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      rankInputRefs.current[index - 1]?.focus();
      rankInputRefs.current[index - 1]?.select?.();
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
    showNotice(`PDF report downloaded (${report.fileName}).`, 'ok');
  };

  const downloadRecord = () => {
    if (!record) {
      return;
    }
    downloadFile(record, `uec-ballot-record-${safeFileStem(positionTitle)}.txt`, 'text/plain;charset=utf-8');
    showNotice('Ballot record downloaded. Run sha256sum on it to check the digest in the PDF.', 'ok');
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
    downloadFile(`${csv}\r\n`, `uec-ballot-ledger-${safeFileStem(positionTitle)}.csv`, 'text/csv;charset=utf-8');
    showNotice('Ledger CSV downloaded.', 'ok');
  };

  const downloadSession = () => {
    downloadFile(
      JSON.stringify({ ...session, savedAt: new Date().toISOString() }, null, 2),
      `uec-session-${safeFileStem(positionTitle)}.json`,
      'application/json',
    );
    showNotice('Session file downloaded.', 'ok');
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
          showNotice('That file is not an Easy Vote session.', 'warn');
          return;
        }

        if (
          ballots.length > 0 &&
          !window.confirm(`This replaces the current count of ${ballots.length} slip(s). Continue?`)
        ) {
          return;
        }

        resetDraft();
        setSession({ ...emptySession(), ...parsed, phase: 'results' });
        showNotice('Session loaded. Check the ballot record digest against the original report.', 'ok');
      } catch {
        showNotice('That file could not be read as JSON.', 'warn');
      }
    };
    reader.readAsText(file);
  };

  const electionType = ELECTION_TYPES[electionTypeId] ?? ELECTION_TYPES[DEFAULT_ELECTION_TYPE];

  /* ================================================================ *
   * Setup
   * ================================================================ */

  const renderSetup = () => (
    <div className="space-y-5">
      <section className="rounded-[1.75rem] border border-[#c87820]/30 bg-white/90 p-6 shadow-soft">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Count a UEC paper ballot</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-[#2c2010]">
          Type in the slips one at a time, then download a PDF report you can sign and file. Everything stays in
          this browser &mdash; no ballot data is sent anywhere.
        </p>
        <ol className="mt-5 grid gap-3 sm:grid-cols-3">
          {[
            ['1', 'Set up', 'Name the position and the candidates.'],
            ['2', 'Transcribe', 'Enter the numbers from each slip.'],
            ['3', 'Report', 'Download the PDF and the audit files.'],
          ].map(([number, title, blurb]) => (
            <li key={number} className="rounded-2xl border border-[#d48020]/25 bg-[#fbf6dc] p-4">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[#2c2010] text-xs font-bold text-[#fffdf5]">
                {number}
              </div>
              <div className="mt-2 font-bold">{title}</div>
              <div className="mt-1 text-sm text-[#2c2010]">{blurb}</div>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
        <div className={card}>
          <label className={labelClass} htmlFor="position-title">
            Position being counted
          </label>
          <input
            id="position-title"
            ref={positionInputRef}
            value={positionTitle}
            onChange={(event) => update({ positionTitle: event.target.value })}
            onKeyDown={(event) => event.key === 'Enter' && beginTranscribing()}
            placeholder="President"
            autoComplete="off"
            className={inputClass}
          />

          <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">Candidates</h2>
              <p className="text-sm text-[#2c2010]">Everyone on the ballot, in nomination order.</p>
            </div>
            <button
              type="button"
              onClick={() => update({ candidates: [...candidates, createCandidate()] })}
              className="rounded-full border border-[#c87820]/40 bg-white px-4 py-2 text-sm font-semibold transition hover:border-[#c87820] hover:bg-[#f5e060]"
            >
              + Add candidate
            </button>
          </div>

          <div className="mt-4 space-y-2.5">
            {candidates.map((candidate, index) => (
              <div
                key={candidate.id}
                className="flex items-center gap-3 rounded-2xl border border-[#d48020]/25 bg-[#fbf6dc] p-2.5"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#2c2010] text-sm font-bold text-[#fffdf5]">
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
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && index === candidates.length - 1) {
                      update({ candidates: [...candidates, createCandidate()] });
                    }
                  }}
                  placeholder={`Candidate ${index + 1}`}
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-xl border border-[#d48020]/40 bg-white px-4 py-2.5 text-base outline-none transition placeholder:text-[#b09060] focus:border-[#c87820]"
                />
                <button
                  type="button"
                  onClick={() =>
                    candidates.length > 2 &&
                    update({ candidates: candidates.filter((entry) => entry.id !== candidate.id) })
                  }
                  disabled={candidates.length <= 2}
                  className="rounded-xl px-3 py-2 text-sm font-semibold text-[#c87820] transition hover:bg-[#f5e060] hover:text-[#1a1a1a] disabled:opacity-25"
                  aria-label={`Remove candidate ${index + 1}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          {setupError ? (
            <div
              className="mt-4 rounded-2xl border border-[#8c1d1d]/40 bg-[#8c1d1d]/10 px-4 py-3 text-sm font-semibold text-[#8c1d1d]"
              role="alert"
            >
              {setupError}
            </div>
          ) : null}

          <button type="button" onClick={beginTranscribing} className={`${primaryButton} mt-6 w-full`}>
            Start transcribing slips &rarr;
          </button>
        </div>

        <aside className="space-y-4">
          <details className={card}>
            <summary className="cursor-pointer select-none text-base font-bold">
              Ballot type &mdash; {electionType.id === 'elected' ? 'Elected position' : 'Appointed position'}
            </summary>
            <div className="mt-4 space-y-2.5">
              {Object.values(ELECTION_TYPES).map((type) => (
                <label
                  key={type.id}
                  className={`flex cursor-pointer gap-3 rounded-2xl border p-3.5 transition ${
                    electionTypeId === type.id
                      ? 'border-[#c87820] bg-[#fbf6dc]'
                      : 'border-[#d48020]/25 bg-white hover:border-[#c87820]/60'
                  }`}
                >
                  <input
                    type="radio"
                    name="election-type"
                    checked={electionTypeId === type.id}
                    onChange={() => update({ electionTypeId: type.id })}
                    className="mt-1 h-4 w-4 shrink-0 accent-[#c87820]"
                  />
                  <span>
                    <span className="block font-bold">{type.label}</span>
                    <span className="mt-1 block text-xs leading-5 text-[#2c2010]">
                      Counted under {type.countAuthority}. Ties go to {type.tieAuthority}.
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </details>

          <details className={card}>
            <summary className="cursor-pointer select-none text-base font-bold">
              Names for the report <span className="font-normal text-[#2c2010]">(optional)</span>
            </summary>
            <div className="mt-4 space-y-4">
              <div>
                <label className={labelClass} htmlFor="returning-officer">
                  Returning Officer
                </label>
                <input
                  id="returning-officer"
                  value={returningOfficer}
                  onChange={(event) => update({ returningOfficer: event.target.value })}
                  placeholder="Printed on the report"
                  autoComplete="off"
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
                  placeholder="Comma separated"
                  autoComplete="off"
                  className={inputClass}
                />
              </div>
              <p className="text-xs text-[#2c2010]/70">
                Left blank, the report prints signature lines instead.
              </p>
            </div>
          </details>

          <div className="rounded-[1.75rem] border border-dashed border-[#c87820]/40 bg-white/70 p-5">
            <h2 className="font-bold">What you get at the end</h2>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-[#2c2010]">
              <li>
                <strong>A PDF report</strong> with first preference votes for every candidate, every round of the
                count, and the full ballot ledger.
              </li>
              <li>
                <strong>A ballot record</strong> whose SHA-256 is printed in the report, so any later change is
                detectable.
              </li>
              <li>
                <strong>A CSV</strong> of every slip, for re-counting in a spreadsheet.
              </li>
            </ul>
          </div>

          <div className={card}>
            <h2 className="font-bold">Resuming a count?</h2>
            <p className="mt-2 text-sm text-[#2c2010]">
              Work in progress is saved in this browser automatically. You can also load a session file.
            </p>
            <button type="button" onClick={() => fileInputRef.current?.click()} className={`${secondaryButton} mt-3`}>
              Load session file
            </button>
          </div>
        </aside>
      </section>
    </div>
  );

  /* ================================================================ *
   * Transcription
   * ================================================================ */

  const renderEntry = () => {
    const isClean = draftClassification.status === BALLOT_FORMAL && !draftClassification.requiresReview;
    const nothingTyped = Object.values(draftMarks).every((value) => String(value).trim() === '');

    return (
      <div className="space-y-5">
        <section className="rounded-[1.75rem] border border-[#c87820]/25 bg-white/95 p-5 shadow-soft sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{positionTitle}</h1>
              <p className="mt-1 text-sm text-[#2c2010]">
                {electionType.label} &middot; {namedCandidates.length} candidates
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Stat label="Slips" value={ballots.length} tone="dark" />
              <Stat label="Formal" value={result?.reconciliation.formal ?? 0} />
              <Stat label="Informal" value={result?.reconciliation.informal ?? 0} />
              <Stat label="Need review" value={result?.reconciliation.flaggedForReview ?? 0} />
            </div>
          </div>
        </section>

        <section className={editingSerial === null ? card : `${card} ring-2 ring-[#c87820]`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-extrabold">
                {editingSerial === null ? `Slip ${nextSerial}` : `Amending slip ${editingSerial}`}
              </h2>
              <p className="text-sm text-[#2c2010]">
                Type the number written beside each candidate. Leave blank where the slip is blank.
              </p>
            </div>

            {namedCandidates.length <= 20 ? (
              <button
                type="button"
                onClick={toggleFastEntry}
                className="rounded-full border border-[#c87820]/40 bg-white px-4 py-2 text-xs font-bold transition hover:bg-[#f5e060]"
                aria-pressed={fastEntry}
              >
                {fastEntry ? 'Switch to one row per candidate' : 'Switch to fast entry'}
              </button>
            ) : null}
          </div>

          {fastEntry ? (
            <div className="mt-5">
              <label className={labelClass} htmlFor="fast-entry">
                Numbers in candidate order
              </label>
              <input
                id="fast-entry"
                ref={fastInputRef}
                value={fastText}
                onChange={(event) => setFast(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitBallot();
                  }
                }}
                inputMode={namedCandidates.length > 9 ? 'text' : 'numeric'}
                placeholder={namedCandidates.length > 9 ? '2,1,3,...' : '213'}
                autoComplete="off"
                className={`${inputClass} font-mono text-2xl tracking-[0.3em]`}
              />
              <p className="mt-2 text-xs text-[#2c2010]/75">
                One digit per candidate, in the order listed below. Use a dot for an unmarked candidate
                {namedCandidates.length > 9 ? ', separating each with a comma' : ''}. Enter records the slip.
              </p>

              <ol className="mt-4 grid gap-1.5 sm:grid-cols-2">
                {namedCandidates.map((candidate, index) => (
                  <li
                    key={candidate.id}
                    className="flex items-center justify-between gap-3 rounded-xl bg-[#fbf6dc] px-3 py-2 text-sm"
                  >
                    <span className="truncate">
                      <span className="mr-2 font-mono text-xs text-[#c87820]">{index + 1}</span>
                      {candidate.name}
                    </span>
                    <span className="font-mono font-bold tabular-nums">{draftMarks[candidate.id] || '-'}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <div className="mt-5 grid gap-2.5">
              {namedCandidates.map((candidate, index) => (
                <div
                  key={candidate.id}
                  className="grid items-center gap-3 rounded-2xl border border-[#d48020]/20 bg-[#fbf6dc] p-3.5 sm:grid-cols-[1fr_auto]"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-[#c87820]">{index + 1}</span>
                    <span className="text-base font-semibold">{candidate.name}</span>
                  </div>
                  <label className="flex items-center gap-3 sm:justify-end">
                    <span className="text-sm font-semibold text-[#2c2010]">Number</span>
                    <input
                      value={draftMarks[candidate.id] ?? ''}
                      onChange={(event) => setMark(candidate.id, event.target.value)}
                      onKeyDown={(event) => handleMarkKeyDown(event, index)}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      placeholder="&ndash;"
                      aria-label={`Preference number for ${candidate.name}`}
                      ref={(element) => {
                        rankInputRefs.current[index] = element;
                      }}
                      className="h-12 w-20 rounded-xl border border-[#d48020]/40 bg-white text-center text-lg font-extrabold outline-none transition placeholder:text-[#b09060] focus:border-[#c87820]"
                    />
                  </label>
                </div>
              ))}
            </div>
          )}

          {/* Live formality feedback, so a problem slip is caught at the slip
              rather than discovered at the end of the count. */}
          <div
            className={`mt-5 rounded-2xl border px-4 py-3 text-sm ${
              nothingTyped
                ? 'border-[#d48020]/30 bg-[#fbf6dc] text-[#2c2010]/80'
                : isClean
                  ? 'border-[#2a4a1f]/30 bg-[#e8f3e4] text-[#2a4a1f]'
                  : 'border-[#d48020]/50 bg-[#fcd703]/20 text-[#2c2010]'
            }`}
            role="status"
            aria-live="polite"
          >
            {nothingTyped ? (
              <span>Nothing typed yet.</span>
            ) : (
              <>
                <div className="font-bold">
                  {draftClassification.status === BALLOT_FORMAL
                    ? `Counts as formal: ${draftClassification.preferences
                        .map(
                          (id, index) =>
                            `${index + 1}. ${namedCandidates.find((entry) => entry.id === id)?.name}`,
                        )
                        .join('   ')}`
                    : 'Counts as informal — no first preference can be read from this slip.'}
                </div>
                {draftClassification.flags.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {draftClassification.flags.map((flag) => (
                      <li key={flag}>{FLAG_DESCRIPTIONS[flag] ?? flag}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </div>

          <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
            <button type="button" onClick={() => commitBallot()} className={primaryButton}>
              {editingSerial === null ? `Record slip ${nextSerial}` : 'Save amendment'}
            </button>
            <button type="button" onClick={() => commitBallot({ informal: true })} className={secondaryButton}>
              Record as informal
            </button>
          </div>

          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
            {editingSerial === null ? (
              <button
                type="button"
                onClick={undoLastSlip}
                disabled={!lastSlip}
                className={secondaryButton}
                title={lastSlip ? `Remove slip ${lastSlip.serial} and put it back in the form` : 'Nothing to undo'}
              >
                {lastSlip ? `Undo slip ${lastSlip.serial}` : 'Undo'}
              </button>
            ) : (
              <button type="button" onClick={resetDraft} className={secondaryButton}>
                Cancel amendment
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                resetDraft();
                requestFocus();
              }}
              className={secondaryButton}
            >
              Clear form
            </button>
          </div>

          <details className="mt-4 text-sm text-[#2c2010]">
            <summary className="cursor-pointer select-none font-semibold">Keyboard shortcuts</summary>
            <ul className="mt-2 space-y-1 pl-1">
              {fastEntry ? (
                <li>
                  <kbd className="rounded bg-[#fbf6dc] px-1.5 py-0.5 font-mono text-xs">Enter</kbd> records the slip.
                </li>
              ) : (
                <>
                  <li>
                    <kbd className="rounded bg-[#fbf6dc] px-1.5 py-0.5 font-mono text-xs">Enter</kbd> or{' '}
                    <kbd className="rounded bg-[#fbf6dc] px-1.5 py-0.5 font-mono text-xs">&darr;</kbd> moves to the
                    next candidate; from the last one it records the slip.
                  </li>
                  <li>
                    <kbd className="rounded bg-[#fbf6dc] px-1.5 py-0.5 font-mono text-xs">&uarr;</kbd> moves back a
                    candidate.
                  </li>
                </>
              )}
              <li>Fast entry is quicker for long counts: type all the numbers in one field.</li>
            </ul>
          </details>
        </section>

        <div className="grid gap-2.5 sm:grid-cols-2">
          <button type="button" onClick={() => update({ phase: 'results' })} className={primaryButton}>
            Finish &amp; see the result &rarr;
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} className={secondaryButton}>
            Load session file
          </button>
        </div>

        {renderLedger({ compact: true })}
      </div>
    );
  };

  /* ================================================================ *
   * Ledger
   * ================================================================ */

  const renderLedger = ({ compact }) => {
    const classified = result?.classifiedBallots ?? [];
    const newestFirst = [...classified].reverse();
    const visible = compact && !showAllSlips ? newestFirst.slice(0, 5) : newestFirst;

    return (
      <details className={card} open={!compact || ballots.length > 0}>
        <summary className="cursor-pointer select-none">
          <span className="text-lg font-bold">Ballot ledger</span>
          <span className="ml-2 text-sm font-semibold text-[#c87820]">{ballots.length} slips</span>
        </summary>

        <p className="mt-2 text-sm leading-6 text-[#2c2010]">
          Every slip as transcribed. <strong>Amend</strong> fixes a transcription error; <strong>void</strong> sets a
          slip aside without erasing the record, so the totals always reconcile.
        </p>

        <div className="mt-4 grid gap-2">
          {ballots.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[#d48020]/40 bg-[#fbf6dc] p-5 text-center text-sm text-[#2c2010]">
              No slips yet. Type the first one above and press{' '}
              <kbd className="rounded bg-white px-1.5 py-0.5 font-mono text-xs">Enter</kbd>.
            </div>
          ) : (
            visible.map((entry) => (
              <div
                key={entry.serial}
                className="flex flex-col gap-3 rounded-2xl border border-[#d48020]/20 bg-[#fbf6dc] p-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-[0.16em] text-[#c87820]">
                      Slip {entry.serial}
                    </span>
                    <Pill className={STATUS_STYLES[entry.status]}>{STATUS_LABELS[entry.status]}</Pill>
                    {entry.requiresReview ? (
                      <Pill className="bg-[#fcd703]/60 text-[#2c2010]">Needs review</Pill>
                    ) : null}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {entry.preferences.length > 0 ? (
                      entry.preferences.map((candidateId, index) => (
                        <Pill key={candidateId} className="bg-white text-[#2c2010]">
                          {index + 1}. {result.candidateById[candidateId].name}
                        </Pill>
                      ))
                    ) : (
                      <span className="text-sm text-[#2c2010]/80">Takes no part in the count.</span>
                    )}
                  </div>

                  {entry.flags.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-[#2c2010]/80">
                      {entry.flags.map((flag) => (
                        <li key={flag}>{FLAG_DESCRIPTIONS[flag] ?? flag}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => loadForEditing(entry.serial)}
                    className="min-h-[2.75rem] rounded-xl border border-[#c87820]/40 bg-white px-4 text-sm font-bold transition hover:border-[#c87820] hover:bg-[#f5e060]"
                  >
                    Amend
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleVoid(entry.serial)}
                    className="min-h-[2.75rem] rounded-xl border border-[#2c2010]/30 bg-white px-4 text-sm font-bold transition hover:bg-[#2c2010] hover:text-[#fffdf5]"
                  >
                    {entry.status === BALLOT_VOIDED ? 'Restore' : 'Void'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {compact && newestFirst.length > 5 ? (
          <button
            type="button"
            onClick={() => setShowAllSlips((previous) => !previous)}
            className={`${secondaryButton} mt-3 w-full`}
          >
            {showAllSlips ? 'Show only the latest 5' : `Show all ${newestFirst.length} slips`}
          </button>
        ) : null}
      </details>
    );
  };

  /* ================================================================ *
   * Result
   * ================================================================ */

  const renderOutcome = () => {
    const { outcome } = result;

    if (outcome.status === OUTCOME_ELECTED) {
      return (
        <section className="rounded-[1.75rem] border-2 border-[#2a4a1f]/35 bg-[#e8f3e4] p-6">
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-[#2a4a1f]">Elected</div>
          <h2 className="mt-2 text-4xl font-extrabold">{result.candidateById[outcome.winnerId].name}</h2>
          <p className="mt-3 text-base leading-7 text-[#2a4a1f]">{outcome.detail}</p>
          <p className="mt-2 text-sm text-[#2a4a1f]/85">Determined under {outcome.authority}.</p>
          {outcome.immaterialTies > 0 ? (
            <p className="mt-4 rounded-2xl bg-white/80 px-4 py-3 text-sm leading-6">
              {outcome.immaterialTies} tie(s) for exclusion arose. Every lawful exclusion order was followed through
              and all produced this same result, so no referral is needed. The detail is in the PDF report.
            </p>
          ) : null}
        </section>
      );
    }

    if (outcome.status === OUTCOME_REFERRAL) {
      return (
        <section className="rounded-[1.75rem] border-2 border-[#8c1d1d]/45 bg-[#fcd703]/20 p-6" role="alert">
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-[#8c1d1d]">
            No candidate elected by this count
          </div>
          <h2 className="mt-2 text-2xl font-extrabold">{outcome.headline}</h2>
          <p className="mt-3 text-base leading-7 text-[#2c2010]">{outcome.detail}</p>

          <div className="mt-4 rounded-2xl bg-white p-4">
            <div className="text-sm font-bold">Candidates affected</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {outcome.candidateIds.map((candidateId) => (
                <Pill key={candidateId} className="bg-[#fbf6dc] text-[#2c2010]">
                  {result.candidateById[candidateId].name}
                </Pill>
              ))}
            </div>
          </div>

          <div className="mt-3 rounded-2xl bg-white p-4">
            <div className="text-sm font-bold">What has to happen next ({outcome.authority})</div>
            <p className="mt-2 text-sm leading-6 text-[#2c2010]">{outcome.instruction}</p>
          </div>

          <p className="mt-4 text-sm font-bold text-[#8c1d1d]">
            This program will not break the tie. The Constitution reserves that decision to the Committee.
          </p>
        </section>
      );
    }

    return (
      <section className="rounded-[1.75rem] border-2 border-[#8c1d1d]/45 bg-[#fcd703]/20 p-6" role="alert">
        <div className="text-xs font-bold uppercase tracking-[0.2em] text-[#8c1d1d]">No count possible</div>
        <h2 className="mt-2 text-2xl font-extrabold">{outcome.headline}</h2>
        <p className="mt-3 text-base leading-7 text-[#2c2010]">{outcome.detail}</p>
        <button type="button" onClick={() => update({ phase: 'entry' })} className={`${secondaryButton} mt-4`}>
          &larr; Back to transcribing
        </button>
      </section>
    );
  };

  const renderResults = () => {
    if (!result) {
      return (
        <section className={card}>
          <h1 className="text-2xl font-extrabold">Nothing to count yet</h1>
          <p className="mt-2 text-sm text-[#2c2010]">Add at least two candidates to begin.</p>
          <button type="button" onClick={() => update({ phase: 'setup' })} className={`${secondaryButton} mt-4`}>
            &larr; Back to setup
          </button>
        </section>
      );
    }

    const disclosure = majorityDisclosure(result);
    const failedChecks = result.checks.filter((check) => !check.pass);
    const firstPreferences = result.firstPreferences;

    return (
      <div className="space-y-5">
        <section className="rounded-[1.75rem] border border-[#c87820]/25 bg-white/95 p-5 shadow-soft sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{positionTitle}</h1>
              <p className="mt-1 text-sm text-[#2c2010]">
                {electionType.label} &middot; {electionType.countAuthority} &middot; UEC Constitution, 7 Aug 2026
              </p>
            </div>
            <div className="flex flex-wrap gap-2.5">
              <button type="button" onClick={downloadPdf} className={primaryButton}>
                ⬇ Download PDF report
              </button>
              <button type="button" onClick={() => update({ phase: 'entry' })} className={secondaryButton}>
                &larr; Back to transcribing
              </button>
            </div>
          </div>
        </section>

        {failedChecks.length > 0 ? (
          <section className="rounded-[1.75rem] border-2 border-[#8c1d1d] bg-[#8c1d1d]/10 p-6" role="alert">
            <h2 className="text-lg font-extrabold text-[#8c1d1d]">
              Arithmetic check failed &mdash; do not rely on this count
            </h2>
            <ul className="mt-3 space-y-2 text-sm">
              {failedChecks.map((check) => (
                <li key={check.label}>
                  <strong>{check.label}:</strong> {check.detail}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {renderOutcome()}

        <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label="Slips in ledger" value={result.reconciliation.entriesInLedger} />
          <Stat label="Formal" value={result.reconciliation.formal} />
          <Stat label="Informal" value={result.reconciliation.informal} />
          <Stat label="Voided" value={result.reconciliation.voided} />
        </section>

        {firstPreferences ? (
          <Section
            title="First preference votes"
            blurb={`Number 1 marks on formal ballots. ${firstPreferences.majorityThreshold} of ${firstPreferences.totalFormal} were needed to exceed 50% and be elected outright.`}
          >
            <div className="overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-[0.65rem] uppercase tracking-[0.18em] text-[#2c2010]">
                    <th className="border-b border-[#d48020]/25 pb-2.5 pr-4">Candidate</th>
                    <th className="border-b border-[#d48020]/25 pb-2.5 pr-4 text-right">1st prefs</th>
                    <th className="border-b border-[#d48020]/25 pb-2.5 pr-4 text-right">Share</th>
                    <th className="border-b border-[#d48020]/25 pb-2.5 text-right">Over 50%?</th>
                  </tr>
                </thead>
                <tbody>
                  {namedCandidates
                    .map((candidate) => ({ candidate, votes: firstPreferences.counts[candidate.id] ?? 0 }))
                    .sort((left, right) => right.votes - left.votes)
                    .map(({ candidate, votes }) => (
                      <tr key={candidate.id}>
                        <td className="border-b border-[#f5e060]/60 py-2.5 pr-4 font-semibold">{candidate.name}</td>
                        <td className="border-b border-[#f5e060]/60 py-2.5 pr-4 text-right font-extrabold tabular-nums">
                          {votes}
                        </td>
                        <td className="border-b border-[#f5e060]/60 py-2.5 pr-4 text-right tabular-nums">
                          {firstPreferences.totalFormal === 0
                            ? '-'
                            : `${((votes / firstPreferences.totalFormal) * 100).toFixed(1)}%`}
                        </td>
                        <td className="border-b border-[#f5e060]/60 py-2.5 text-right">
                          {votes >= firstPreferences.majorityThreshold ? 'Yes' : 'No'}
                        </td>
                      </tr>
                    ))}
                  <tr>
                    <td className="py-2.5 pr-4 font-extrabold">Total</td>
                    <td className="py-2.5 pr-4 text-right font-extrabold tabular-nums">
                      {Object.values(firstPreferences.counts).reduce((total, value) => total + value, 0)}
                    </td>
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>
        ) : null}

        {result.rounds.length > 0 ? (
          <Section
            title="Round-by-round count"
            blurb="A dash means the candidate had already been excluded. “Excl.” marks the candidate excluded at the end of that round."
          >
            <div className="overflow-x-auto">
              <table className="min-w-full border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-[0.65rem] uppercase tracking-[0.18em] text-[#2c2010]">
                    <th className="border-b border-[#d48020]/25 pb-2.5 pr-4">Candidate</th>
                    {result.rounds.map((round) => (
                      <th key={round.roundNumber} className="border-b border-[#d48020]/25 pb-2.5 pr-4 text-right">
                        R{round.roundNumber}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {namedCandidates.map((candidate) => (
                    <tr key={candidate.id}>
                      <td className="border-b border-[#f5e060]/60 py-2.5 pr-4 font-semibold">{candidate.name}</td>
                      {result.rounds.map((round) => (
                        <td
                          key={round.roundNumber}
                          className="border-b border-[#f5e060]/60 py-2.5 pr-4 text-right font-extrabold tabular-nums"
                        >
                          {round.continuingIds.includes(candidate.id) ? (
                            <>
                              {round.counts[candidate.id]}
                              {round.excludedId === candidate.id ? (
                                <span className="ml-1 text-[0.65rem] font-semibold text-[#8c1d1d]">Excl.</span>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-[#b09060]">&ndash;</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {[
                    ['Votes counted', (round) => round.continuingBallots],
                    ['Exhausted', (round) => round.exhaustedBallots],
                    ['Needed for >50%', (round) => round.majorityThreshold],
                  ].map(([label, pick]) => (
                    <tr key={label} className="bg-[#fbf6dc]">
                      <td className="py-2.5 pr-4 font-bold">{label}</td>
                      {result.rounds.map((round) => (
                        <td key={round.roundNumber} className="py-2.5 pr-4 text-right font-semibold tabular-nums">
                          {pick(round)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        ) : null}

        {disclosure?.divergent ? (
          <section className="rounded-[1.75rem] border border-[#d48020]/50 bg-[#fcd703]/15 p-5 sm:p-6">
            <h2 className="text-sm font-bold uppercase tracking-[0.18em]">Disclosure</h2>
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
          <Section
            title="Slips needing your attention"
            badge={<Pill className="bg-[#fcd703]/60 text-[#2c2010]">{result.flaggedBallots.length}</Pill>}
            blurb="These departed from clean sequential numbering. Preferences were read from 1 upwards and stopped at the first missing or repeated number. All are listed in the PDF report. Click one to amend it."
          >
            <div className="flex flex-wrap gap-2">
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
          </Section>
        ) : null}

        <Section
          title="Audit files"
          blurb="The PDF is the document of record. The ballot record is the file an auditor hashes: running sha256sum over it must reproduce the digest printed in the report."
        >
          <div className="rounded-2xl bg-[#fbf6dc] p-4">
            <div className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-[#c87820]">
              Ballot record digest ({digest?.algorithm})
            </div>
            <div className="mt-1.5 break-all font-mono text-xs">{digest?.hex}</div>
            <div className="mt-3 text-xs text-[#2c2010]/75">
              Rules {result.rulesVersion} &middot; engine {result.engineVersion}
            </div>
          </div>

          <div className="mt-4 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
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
        </Section>

        {renderLedger({ compact: false })}

        <section className="flex flex-wrap gap-2.5">
          <button type="button" onClick={() => fileInputRef.current?.click()} className={secondaryButton}>
            Load a session file
          </button>
          <button type="button" onClick={discardEverything} className={dangerButton}>
            Discard and start a new count
          </button>
        </section>
      </div>
    );
  };

  /* ================================================================ *
   * Shell
   * ================================================================ */

  const noticeTone = {
    ok: 'border-[#2a4a1f]/35 bg-[#e8f3e4] text-[#2a4a1f]',
    warn: 'border-[#d48020]/50 bg-[#fcd703]/25 text-[#2c2010]',
    info: 'border-[#c87820]/40 bg-white text-[#2c2010]',
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(252,215,3,0.22),_transparent_26%),radial-gradient(circle_at_top_right,_rgba(196,120,32,0.20),_transparent_24%),linear-gradient(180deg,_#fffdf5_0%,_#fbf6dc_52%,_#f5e060_100%)] px-3 py-5 text-[#1a1a1a] sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-baseline gap-3">
            <span className="text-sm font-extrabold uppercase tracking-[0.24em]">Easy Vote</span>
            <span className="text-xs text-[#2c2010]/70">UEC Constitution, 7 Aug 2026</span>
          </div>
          <StepBar
            phase={phase}
            onGo={(next) => update({ phase: next })}
            canLeaveSetup={namedCandidates.length >= 2 && phase !== 'setup'}
            canReturnToSetup={ballots.length === 0}
          />
        </header>

        <div aria-live="polite" className="sr-only">
          {notice?.message ?? ''}
        </div>

        {notice ? (
          <div
            className={`mb-5 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-sm ${
              noticeTone[notice.tone] ?? noticeTone.info
            }`}
          >
            {notice.message}
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

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 text-xs text-[#2c2010]/70">
          <span>Runs entirely in your browser. No ballot data is sent anywhere.</span>
          {ballots.length > 0 ? (
            <span>
              {savedAt
                ? `Saved in this browser at ${savedAt.toLocaleTimeString('en-AU', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}`
                : 'Not saved — browser storage unavailable'}
            </span>
          ) : null}
        </footer>
      </div>
    </main>
  );
};

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
