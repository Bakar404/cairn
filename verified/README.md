# The review rating, proved

After each practice problem, `reviewRating` in [`src/core/review-schedule.ts`](../src/core/review-schedule.ts) turns the outcome into a review rating (Again, Hard or Good), and FSRS turns the ratings into review dates. A wrong rating skews a learner's whole schedule, and nothing on screen would flag it. So this rule is proved, not just tested.

This folder follows the method of [PDD Kit](https://www.microsoft.com/en-us/research/blog/formally-verifying-agent-written-full-stack-web-apps-with-pdd-kit/) from Microsoft Research and GitHub Next. The requirements come first. A spec in [Verus](https://github.com/verus-lang/verus) states them, and Verus proves the code meets them for every input. A mutation check tests the spec itself, and every piece the proof doesn't cover is named, with a check.

## What's here

| File | What it is |
| --- | --- |
| [`src/lib.rs`](src/lib.rs) | The rule in Rust, with its spec: seven `ensures` clauses, C1 to C7, one per requirement. |
| [`check.mjs`](check.mjs) | Runs the five steps below. CI's Proof job runs it on every change. |
| [`review-rating.test.ts`](review-rating.test.ts) | The differential test D and the scheduler checks T1 and T2. |
| `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` | The crate, with Verus's libraries and Rust pinned to the versions the proof was checked with. |

## Run it

You need:

- **Node 26, and `npm ci` at the repo root.** The test imports the app's own code.
- **Rust 1.99.1 with the wasm32 target:** `rustup toolchain install 1.99.1 --profile minimal --target wasm32-unknown-unknown`
- **Verus release [0.2026.11.02.8bf68ee](https://github.com/verus-lang/verus/releases/tag/release/0.2026.11.02.8bf68ee),** unzipped, with `VERUS` set to its `verus` binary. CI downloads the Linux zip and checks its SHA-256.

Then, from the repo root:

```sh
VERUS=/path/to/verus-x86-linux/verus node verified/check.mjs
```

In PowerShell, set `$env:VERUS` to `verus.exe` first. It isn't part of `npm test`, because it needs Rust and Verus.

It prints one line per step. `verified/target/receipt.json` records every count, the tool versions and the SHA-256 of `src/lib.rs`, `review-schedule.ts` and the module, and the full logs are in `verified/target/logs/`. In GitHub Actions the receipt is also the job summary.

## The five steps

| Step | What it checks | It fails when |
| --- | --- | --- |
| 1. Prove | Verus proves `review_rating` meets C1 to C7 for every outcome, rung, careless flag and answer check. | Any clause doesn't hold. |
| 2. Mutation check | Eight planted bugs, M1 to M8, at least one per clause. Verus must reject each on the clause it targets. | A bug proves, or only another clause catches it: the target clause rules out nothing. |
| 3. Build | cargo builds the crate to WebAssembly. A plain build erases every spec and proof, so the module holds only the code Verus checked. | The build fails. |
| 4. Test | D: the app's `reviewRating` and the module rate 10,920 inputs the same way, covering all 630 input classes. T1 and T2 check the review dates (TB3 below). | Any input is rated differently, a class isn't reached, or a lower rating gives a later date. |
| 5. Negative control | D runs again, against M7 built to WebAssembly. | D passes. A D that can't fail would prove nothing. |

## The requirements

Each requirement is quoted from Cairn, then traced to the clause that states it and the evidence behind it.

| # | Requirement | Source | Spec | Evidence |
| --- | --- | --- | --- | --- |
| R1 | "Null when the retrieval doesn't count: a dismissed problem, or an outcome this build doesn't know." | `reviewRating`'s doc comment | C1 | proof, D |
| R2 | "A credited solve is rated by its hint rung: R0–R1 is Good, R2 is Hard, R3–R5 is Again; with no rung, a clean solve is Good and a hinted one Hard. Moved on or surrendered is Again." | doc comment | C2 | proof, D |
| R3 | "the check never raises a rating" | doc comment | C3 | proof, D |
| R4 | "When the answer check (M24) disagrees with a credited outcome the rating drops, to Hard for a partial answer" | doc comment | C4 | proof, D |
| R5 | "and to Again for a wrong or missing one" | doc comment | C5 | proof, D |
| R6 | "A careless miss is a slip, not a gap: never worse than Hard" | doc comment | C6 | proof, D |
| R7 | "that floor applies last, after the check" | doc comment, and a test in [`tests/review-queue.test.tsx`](../tests/review-queue.test.tsx) | C7 | proof, D |
| R8 | "the disagreement can only make your review schedule stricter, never looser" | [Why you can trust it](../README.md#why-you-can-trust-it) | C3, for the rating | proof for the rating; T1 and T2 for the dates |
| R9 | "an idea you solved unaided comes back later, and one you needed hints for or missed comes back sooner" | [Remember what you learn](../README.md#remember-what-you-learn) | C2, for the rating | proof for the rating; T1 for the dates |
| R10 | The rating the app uses is the rating that was proved. | implied by R1 to R9 | none | D, on every input class |

### Two cases the words left open

Writing the spec turned up two cases the doc comment didn't settle. Both keep the app's behavior, and the doc comment now states them:

- **A careless miss that the answer check disputes is rated Hard.** The careless floor applies after the check (C7). Before C7, the spec also allowed a bug (M7) that ignores the check whenever the tutor calls a miss careless.
- **A solve recorded at a giveaway rung, R3 to R5, is rated Again.** The rung is the more specific evidence, and Again is the stricter reading. `tests/review-queue.test.tsx` covers both cases.

## What's trusted, and how it's checked

Everything inside `verus!` in `src/lib.rs` is proved. These pieces aren't:

- **TB1. The WebAssembly shim.** `review_rating_code`, outside `verus!`, turns integer codes into the enums and the result back into a code. *Checked by* D. The negative control shows D can fail.
- **TB2. The adapter and the input classes.** The test maps TypeScript values to the shim's codes. D can cover every input because `reviewRating` only compares its inputs with fixed strings or tests them for truthiness, so each input falls into one of 630 classes and every value in a class is rated the same. *Checked by* D's coverage assertion: 10,920 inputs, including near misses (`"Solved"`, `"r1"`, `"Careless"`), prototype names (`"constructor"`, `"__proto__"`), numbers, `null` and `undefined`, must reach all 630 classes and every result. *And by review:* `reviewRating` and `rungRating` have no other branches.
- **TB3. The scheduler.** ts-fsrs, with Cairn's `REVIEW_PARAMETERS`, turns ratings into dates, and nothing proves it. *Checked by* T1 and T2, through Cairn's own replay. T1 takes 5,000 random histories and rates the next review each way: Again is never due later than Hard, nor Hard later than Good. T2 takes 5,000 more and lowers each earlier rating in turn: the final due date is never later. Because the Proof job runs on every change, a ts-fsrs upgrade has to pass both.
- **TB4. The toolchain.** Verus, Z3, vstd, and rustc with its wasm32 backend are assumed correct, as PDD Kit assumes them. *Not checked.* The mutation check only shows that Verus rejects the planted bugs, and D would catch a miscompiled module unless the TypeScript had the same bug.
- **TB5. The intent.** Turning the requirements into C1 to C7 is a human judgment. The mutation check catches a clause that rules out nothing, but not one that rules out the wrong thing. *Checked by* review: read each clause against the table above.

## Not promised

- **That the tutor's record is right.** A model records the outcome, the rung and the miss class.
- **That the answer check is right.** It's a model too.
- **Which retrievals count, the queue, leeches and the dates.** `retrievalsOf`, `replayRetrievals` and `buildReviewQueue` are outside the spec. T1 and T2 exercise the replay but don't specify it.
- **That a stored check is consistent.** A disagreeing check that judged the answer correct can't be recorded today. If one were, it would count as wrong (Again), the stricter reading.

## Changing the rule

The TypeScript and the Rust change together, or CI fails:

1. Change the words first: the doc comment on `reviewRating`, and the requirements table above.
2. Change the clause in `src/lib.rs` that states the requirement, then the Rust code, until `node verified/check.mjs` proves it.
3. Change `reviewRating` to match. D fails until the two agree on every input class.
4. For a new clause, end its line with the next `// C<n>` tag, which the mutation check reads, and plant a bug for it in the `MUTANTS` list in `check.mjs`. Each mutant's search text must occur exactly once in `src/lib.rs`.

To upgrade Verus, change all its pins at once: `VERUS_VERSION` and `VERUS_SHA256` in [`ci.yml`](../.github/workflows/ci.yml), the three crate versions in `Cargo.toml` (then run `cargo update` here), and the Rust channel in `rust-toolchain.toml` and in ci.yml's install step. The channel must match the toolchain in the release's `version.json`.

## Why the app still runs the TypeScript

The module could ship in the app, with `reviewRating` calling it, the way PDD Kit routes a handler through its verified function. This rule doesn't need that. Its inputs fall into finitely many classes, so D compares the two on all of them, and the TypeScript can't drift from the proof without failing CI. Nothing new loads at runtime, and building Cairn doesn't need Rust. A rule whose inputs can't be enumerated, such as the cross-site write guard, would need the proved code itself to ship.
