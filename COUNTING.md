# Counting rules and where they come from

Every rule the program applies, and the provision of the **UEC Constitution
(7 August 2026)** it comes from. This document exists so that a Returning
Officer or scrutineer can check the program's behaviour against the
Constitution without reading the source.

The rules live in [`src/counting.js`](src/counting.js) and are exercised by
[`src/counting.test.mjs`](src/counting.test.mjs). Run `npm test` to verify them.

---

## 1. How a candidate is elected

> **s 2.05(i)** — "Ballots shall call for candidates to be ranked in order of the
> voter's preference. When counting, the returning officer should count votes
> according to a conventional preferential voting system and announce a winner
> when one candidate has received more than 50% of the 1st preference votes."

| Rule applied | Detail |
| --- | --- |
| Each formal ballot gives one vote to its most preferred candidate still continuing. | Round 1 is therefore the first preference count. |
| A candidate is elected on **more than** half the votes counted in a round. | Exactly 50% is not a majority. The threshold is `floor(votes counted / 2) + 1`. |
| Where no candidate has a majority, the candidate with the fewest votes is excluded and their ballots pass to the next preference still continuing. | The conventional preferential system s 2.05(i) requires. |
| The last continuing candidate is elected, provided they hold at least one vote. | |

### The denominator, and why both are published

s 2.05(i) speaks of "the 1st preference votes", while a conventional
preferential count measures the majority against the ballots **still being
counted** — a ballot whose marked preferences are all excluded is *exhausted*
and leaves the count. The two denominators differ as soon as any ballot
exhausts.

The program applies the conventional system, as s 2.05(i) directs. Because the
difference is capable of mattering, the report publishes **three** measures
side by side under "Basis of the majority":

- the winner's votes against the ballots still counted in the final round (the rule applied);
- the winner's votes against all formal ballots cast;
- the winner's first preference votes against all formal ballots.

Where the winner holds a majority of the former but not the latter, the report
prints an explicit **DISCLOSURE** box saying so. The Returning Officer is told
rather than left to assume.

---

## 2. Ties — the program never breaks one

> **s 2.05(j)** — "Where a preferential count results in a tie between candidates
> for an Elected position, the tied candidates shall be put to an appointed vote
> of the Committee to determine the successful candidate. Only persons who ran
> as candidates in the original election for that position may be considered in
> the appointed vote."

> **s 2.03(a)–(b)** — Appointed Positions are filled by preferential ballot of the
> Elected Committee Members, supervised by the Secretary as Returning Officer; a
> tie is resolved under s 1.09(g).

> **s 1.09(g)** — "...questions at Committee Meetings must be decided by a majority
> of votes, however if there is no majority, the person presiding over the
> meeting will have a casting vote in addition to their deliberative vote."

The Constitution assigns tie resolution to **humans**. The program therefore has
no tie-break rule of any kind. When a tie could change who is elected, the count
halts and the report states the referral required — s 2.05(j) for an Elected
position, s 2.03(b)/s 1.09(g) for an Appointed one — and names the candidates
affected. No winner is printed anywhere in that report.

### Immaterial ties do not force a referral

A tie *for exclusion* is not necessarily a tie in the result. If two candidates
are equally last and both their preference pools flow the same way, the eventual
winner is the same whichever is excluded first.

Rather than guess, the program **follows every lawful exclusion order to its
conclusion**:

- all orders elect the same candidate → the tie could not have mattered. The
  result is declared and the tie, with the outcome of each branch, is set out in
  the report under "Ties arising during the count".
- any two orders differ, or any order fails to produce a winner → the count halts
  for referral.

Exhaustive exploration is sound where a single guess is not. Exploration is
memoised on the set of continuing candidates and capped
(`MAX_EXPLORED_STATES`); if the cap is ever reached the count halts for referral
rather than reporting an uncertain result.

### What is *not* reported

Instant-runoff elimination order is **not** a ranking, so the program does not
report a "2nd place" or "3rd place". A casual vacancy is filled by majority vote
of the Committee under s 4.01, not by promoting a runner-up, and publishing a
spurious placing invites exactly that error.

---

## 3. Ballot formality

The Constitution does not legislate for defective slips, so conventional
preferential practice applies. The counted preference sequence is read from 1
upwards and **stops at the first number that is missing or used twice**.

| Slip | Treatment | Flagged? |
| --- | --- | --- |
| `1, 2, 3` complete | Formal, all preferences counted | No |
| `1` only, rest blank | Formal, counted as a single preference — a lawful partial vote | No |
| `1, 3` (gap at 2) | Formal, counted as `1` only | Yes — *skipped number* |
| `1, 2, 2` (repeat) | Formal, counted as `1` only | Yes — *repeated number* |
| A number above the candidate count | Recorded, never reached by the count | Yes — *number out of range* |
| No `1` anywhere | **Informal**, takes no part in the count | Yes |
| `1` against two candidates | **Informal** | Yes |
| Wholly blank | **Informal** | No |

Nothing is silently reinterpreted. Every flagged slip appears in the report by
serial number, showing the marks **as transcribed** beside **what was counted
from it** and the reason it was flagged, for the Returning Officer to
adjudicate.

Entries are **voided, never deleted**. A voided slip keeps its serial number and
stays in the ledger and the report, marked as voided, taking no part in the
count. This is what makes the reconciliation meaningful:

```
entries in ledger = formal + informal + voided
votes counted in a round + exhausted ballots = formal ballots
```

Both identities are printed in the report as checks and must read PASS.

---

## 4. Guards against declaring a result that is not there

The program refuses to declare a winner where:

- there are fewer than two candidates;
- there are no formal ballots (an empty ledger, or every slip informal);
- every ballot has exhausted and no continuing candidate holds a vote;
- the round-by-round trace disagrees with the exhaustive check — a condition that
  should be impossible, and is treated as a defect requiring a manual count.

The displayed result is recomputed from the ledger on every render, so what is on
screen can never be a stale snapshot of an earlier set of ballots.

---

## 5. Audit trail

| Output | Purpose |
| --- | --- |
| **PDF report** | The document of record: declaration or referral, reconciliation, first preference votes per candidate, every round, tie disclosures, arithmetic checks, flagged slips, the complete ballot ledger, and a certification block for signature. |
| **Ballot record (`.txt`)** | A canonical transcription of the candidates and every ballot mark. Its SHA-256 is printed in the report and in the footer of every page. |
| **Ledger (`.csv`)** | Every slip as transcribed, for independent re-counting in a spreadsheet. |
| **Session (`.json`)** | Reloadable working state, for resuming an interrupted count. |

### Verifying a report

```sh
sha256sum uec-ballot-record-president.txt
```

The value must equal the "Ballot record digest" printed in the PDF. Any
alteration to the ledger, however small, changes it.

The report is a pure function of the ledger and the timestamp, so re-running the
same count produces a byte-identical PDF. The counting engine has no
dependencies and the PDF writer is in-tree
([`src/pdf.js`](src/pdf.js)) with uncompressed content streams, so a report's
text can be read straight out of the `.pdf` with `strings`.

### Scrutiny requirements the program cannot enforce

- **s 2.05(c)** — General Elections must be supervised by, and the ballot cards
  counted by, at least one appointed Returning Officer who may **not** be a
  Member of the Club.
- **s 2.03(a)** — an Appointed Position ballot is taken of the Elected Committee
  Members and supervised by the Secretary as Returning Officer; a Committee
  Member may vote only for positions for which they are eligible to nominate
  (s 2.06).

These are printed on the report as reminders. They are matters of procedure
outside the program's control.
