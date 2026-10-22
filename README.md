# easy-vote

Client-side preferential ballot counter for **The University Engineers' Club**,
counting under the UEC Constitution of 7 August 2026.

Transcribe paper slips one at a time, then produce a signed-off PDF count report.
Everything runs in the browser; no ballot data leaves the machine.

## Running it

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # verifies the counting rules and the PDF output
npm run build
```

## What it does

- Counts a **conventional preferential ballot** under s 2.05(i): a candidate is
  elected on more than 50% of the votes counted, with the preferences of
  excluded candidates distributed in order.
- **Never breaks a tie.** The Constitution reserves that to the Committee
  (s 2.05(j) for Elected positions, s 2.03(b)/s 1.09(g) for Appointed ones), so
  where a tie could change the result the count halts and the report states the
  referral required. Ties that provably cannot change the result are followed
  through every lawful exclusion order and disclosed rather than referred.
- Classifies each slip as formal or informal and **itemises every defect** —
  skipped number, repeated number, out-of-range number — against its serial
  number for the Returning Officer to adjudicate.
- Voids rather than deletes, so the ledger always reconciles.
- Saves the session as you go, so a refresh or a flat battery does not lose the
  count.

## Outputs

| File | Contents |
| --- | --- |
| `uec-count-<position>-<time>.pdf` | The document of record — declaration or referral, reconciliation, first preference votes per candidate, every round of the count, tie disclosures, arithmetic checks, flagged slips, the full ballot ledger, and a certification block. |
| `uec-ballot-record-<position>.txt` | Canonical transcription of candidates and ballot marks. Its SHA-256 is printed in the report. |
| `uec-ballot-ledger-<position>.csv` | Every slip as transcribed, for re-counting in a spreadsheet. |
| `uec-session-<position>.json` | Reloadable working state. |

To verify a report has not been altered:

```sh
sha256sum uec-ballot-record-president.txt
```

The result must match the "Ballot record digest" in the PDF.

## Layout

| Path | Role |
| --- | --- |
| [`src/counting.js`](src/counting.js) | The counting rules. Pure, no dependencies, independently testable. |
| [`src/report.js`](src/report.js) | Builds the PDF count report. |
| [`src/pdf.js`](src/pdf.js) | In-tree PDF writer, so producing an official report depends on no third-party library or CDN. |
| [`src/main.jsx`](src/main.jsx) | Transcription and results interface. |
| [`COUNTING.md`](COUNTING.md) | **Every rule applied, mapped to the provision of the Constitution it comes from.** Read this to audit the program's behaviour. |
