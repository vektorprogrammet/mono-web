# Lifecycle machines

Status: draft (2026-10-10), pending operator approval. This specification is
the replacement contract that `AGENTS.md` requires before XState enters the
repository. It changes no code.

Measurement commit: `815a28f8` (main). Every number comes from a scan of the
tree at that commit or from a named file and line. A statement that the tree
does not prove is marked `[INFERENCE]`. Package facts come from the declaration
files of the packages at the versions that Dependencies names.

## Problem

Every lifecycle in the backend is implicit. A lifecycle is a set of named
states and the commands that move one aggregate between them. The code writes
the legal transitions as branches, in several places and in several forms.
[INFERENCE] No artifact in the tree lists them as data. The repository has no
XState dependency.

`docs/system.md` describes the intended behavior of these lifecycles in prose
(`## Core lifecycles`, line 162). This specification covers their form in code.

### The lifecycles

| Lifecycle | States | Transitions decided in | Effects |
| --- | --- | --- | --- |
| Receipt | `Pending`, `Approved`, `Rejected`, `Withdrawn` (`packages/domain/src/receipt/schema.ts:95-100`). Settlement is separate evidence. | One function, `decideReceipt` (`packages/domain/src/receipt/update.ts:383`), for submit, revise, withdraw, approve, reject, and reopen-rejected | Outbox requests `PromoteReceiptFile`, `DeleteReceiptFile`, four `Notify*` kinds, and `WriteReceiptAudit` (`packages/domain/src/receipt/effects.ts:12-26`) |
| Interview invitation | `Pending`, `Accepted`, `Rejected`, `RequestedNewTime` (`packages/domain/src/recruitment/schema.ts:407-412`) | Split. The adapter records the response (`packages/database/src/recruitment/invitation-response-postgres.ts:64`). Scheduling reads the state (`packages/domain/src/recruitment/scheduling.ts:20`). | Mail for `Rejected` and `RequestedNewTime` (`packages/domain/src/recruitment/effects.ts:82-93`) |
| Interview conduct | Scheduled, then completed or cancelled. Corrections append revisions. The state comes from the `conduct` and `cancellation` fields. | `finalizeInterview`, `cancelInterview`, and `correctInterviewAssessment` (`packages/domain/src/recruitment/conduct.ts:237,304,361`). The stale revision guard is at `:98`. | Interview completion outbox, a notification with the interviewer name and email (`packages/domain/src/recruitment/effects.ts:49-62`) |
| Placement proposal | `Draft`, `Confirmed` (`packages/domain/src/placements/schema.ts:134`) | The adapter checks the status (`packages/database/src/placements/postgres.ts:257,298`). A trigger permits one confirmation (`packages/database/migrations/0045-native-school-service-delivery.sql:46-50`). | One notification outbox row for each person (`postgres.ts:286`) and an audit row (`:290`) |
| Dated service decision | None, then `Completed`, `Cancelled`, or `Unfulfilled` (`packages/domain/src/placements/schema.ts:171-172`) | `decideService` in the database adapter (`packages/database/src/placements/coverage.ts:527-582`). The interval rule and the attendance rule are at `:541-546` and `:563-568`. | Decision, occurrence, and absence closure rows, and an audit row (`coverage.ts:250-264`) |
| Affiliation | `Absent` (derived: no row), `Pending`, `Active`, `Inactive` (`packages/database/migrations/0032-native-volunteer-placement.sql:4`) | `nextAffiliationStatus` (`packages/domain/src/placements/policy.ts:75`), applied at `packages/database/src/placements/postgres.ts:124-126` | An audit row (`postgres.ts:129`) |
| Admission outcome | `ApplicationSubmitted`, then `OutcomeAnnounced`, which is terminal. The outcome is `Admitted` or `Rejected` (`packages/domain/src/admissions/outcome.ts:21,43`). | `packages/domain/src/admissions/outcome.ts` and `packages/database/src/admissions/outcome.ts` | One immutable mail envelope in `admission_outcome_outbox` (`packages/database/migrations/0082-admission-outcome-mail.sql:157`) |
| Onboarding invitation and delivery | Invitation: `Open`, `Revoked`, `Claimed`. The list query adds the derived `Absent`, `Expired`, and `Linked` (`packages/database/src/onboarding/postgres.ts:37`). Delivery: `Pending`, `Claimed`, `Delivered`, `Cancelled`. | SQL strings in `packages/database/src/onboarding/postgres.ts:70,83,126` and in `apps/backend/src/onboarding/delivery.ts:62-124` | The claim links the applicant to the account (`postgres.ts:125`). Delivery sends mail inside the request. |
| Appointment and delegation | `Future`, `Current`, `Ended`, derived from a half-open interval at one instant (`packages/domain/src/organization/lifecycle.ts:28,188-192`, `packages/domain/src/authz/delegation.ts:221,236-240`) | `transitionAppointment` (`packages/domain/src/organization/lifecycle.ts:213`) and the delegation commands (`packages/domain/src/authz/delegation.ts`) | Session expiry |
| Account access | `Enabled`, `Disabled`: a `disabled` flag with a revision | `transitionAccountAccess` (`packages/domain/src/identity/access.ts:20`), applied at `packages/database/src/identity-access.ts:75` | The same transaction caps session expiry and deletes reset tokens (`identity-access.ts:88-89`) |
| Content article | `Draft`, `Published`. `Draft` means that `currentVersionNumber` is null (`packages/domain/src/content/projection.ts:51`, `packages/database/src/content/postgres.ts:281-282,419`). | `publishPostgres` and `unpublishPostgres` in `packages/database/src/content/postgres.ts`, reached from one handler (`apps/backend/src/content/http-commands.ts:348-364`) | A command receipt (`content_publication_command_receipts`, `postgres.ts:544`) and an audit row (`content_publication_audit`, `:561`) |
| Outbox envelope | `Pending`, `Processing`, `Delivered`, `Failed`, `Quarantined`. The team application table adds `Cancelled`. Claim, release, and stale recovery move a row between `Processing` and `Pending` or `Failed`. | `packages/database/src/outbox-lifecycle.ts` and three bespoke variants: password reset (`packages/database/src/password-recovery.ts:381`), onboarding delivery (`apps/backend/src/onboarding/delivery.ts:62`), and team application (`packages/database/src/team-application/outbox.ts`) | Provider calls after commit |

### Sets that exist twice

Each pair below states one set of values in two places. A search of
`packages/database/src`, `packages/domain/src`, and `tools/conventions` for the
receipt status CHECK finds no comparison with `ReceiptStatusSchema`.
[INFERENCE] The other pairs have no comparison either.

- Receipt status. TypeScript has `ReceiptStatusSchema`
  (`packages/domain/src/receipt/schema.ts:95-100`). SQL has
  `economy_receipts_status_check`
  (`packages/database/migrations/0048-expense-settlement-evidence.sql:25`). A
  third rule ties `approved_at` to the `Approved` status (`:27-31`).
- Placement proposal. TypeScript has `Draft` and `Confirmed`
  (`packages/domain/src/placements/schema.ts:134`). SQL has the CHECK, a rule
  that ties the confirmation fields to the status, and the one-confirmation
  trigger (`0045-native-school-service-delivery.sql:18,28-29,46-50`). The
  adapter checks the status a third time (`postgres.ts:257,298`).
- Affiliation. SQL has `CHECK(status IN ('Pending','Active','Inactive'))`
  (`0032-native-volunteer-placement.sql:4`). TypeScript has the transition
  function `nextAffiliationStatus` (`policy.ts:75`). `Absent` exists only in
  TypeScript.
- Outbox status. A text search of the migrations for the set `Pending`,
  `Processing`, `Delivered`, `Failed` finds 14 CHECK lines in 13 files. Later
  migrations replace some of them.
- Dated service decision. The rule that a decision needs a finished interval,
  and attendance that meets or misses the demand, lives in the adapter
  (`coverage.ts:541-546,563-568`) and again in Foldkit (next section).

### Rules that Foldkit repeats

- `apps/dashboard/app/foldkit/interview/update.ts:62-74`. The function
  `actionMatchesObservation` re-encodes which response state each action
  produces. Its property test states that response transitions leave `Pending`
  only (`update.property.test.ts:81`).
- `apps/dashboard/app/foldkit/dated-school-service/view.ts:141-153`. The form
  re-encodes the decision rule of `coverage.ts:563-568` and the interval rule.
  Its comment at `:142` says that the backend derives the same rule. The view
  also requires a `Confirmed` proposal before dates can be planned (`:42`).
- The counter-example is content. The server derives `canPublish` and
  `canRevise` (`packages/domain/src/content/projection.ts:55-60`), and Foldkit
  only reads them (`apps/dashboard/app/foldkit/content/update.ts:133,300`). The
  target pattern exists for one lifecycle.

## Decision

Operator decision, 2026-10-10: write each lifecycle as an XState machine, and
run one `@xstate/effect` actor for each command. The pattern is the rat-stack
skill [add a lifecycle machine](https://ratstack.sh/skills/add-a-lifecycle-machine).

1. One actor for each command. `setupEffect` declares the actors and the
   schemas. `fromEffect` defines each effect outside the machine. The runner
   starts the actor with `createEffectActor` inside `Effect.scoped`, sends the
   command as the event, and waits with `waitFor`. The spike found that `join`
   has `unknown` in its error channel, which the house rule
   `effecttsgo/any-unknown-in-error-context` rejects after `Effect.orDie`. The
   runner waits with `waitFor` and turns an `ActorStoppedError` into a defect
   that keeps the original error. A machine callback holds no inline Effect.
2. The machine owns the legal transitions. A state lists only the events that
   are legal in it. It has no refusal edge and no wildcard that refuses. The
   spike showed why: a machine that lists every command in every state reports
   a refused command as available through `getNextTransitions` and
   `snapshot.can`, so no allowed-actions projection can read it. Pure
   assigners compute the data of the decision: the next fields, the outbox
   requests, and the audit facts. The decision stays data, as principle 2 of
   the consolidation draft requires.
3. The machine ends with a decision, and nothing else. A refusal is a typed
   failure that the runner raises before it sends the event: a command that the
   hydrated snapshot does not accept (`snapshot.can` is false) fails with the
   typed failure of the lifecycle. The check is part of the runner, not an
   option. A machine drops an event that its state does not list, and the actor
   stays active, so a runner that skips the check waits for ever (mutation M6 of
   the second spike). The runner returns the decision, or fails with the typed
   failure. A machine that ends with no outcome, and an actor error, are
   defects.
4. Declared actors own the effects. An actor can require only the services of
   the transaction: the `Tx` capability of
   `docs/specs/commands-and-concurrency.md`. An actor never requires a mail,
   HTTP, or file service. External work is an outbox envelope that an actor
   writes through `Tx`.
5. Authority and preconditions come first. The runner resolves authority in
   the committing transaction, before it sends the event. `AGENTS.md` requires
   this, and it forbids reuse of an authorization result across transactions or
   retries. The HTTP precondition stays in the transport layer: If-Match against
   the representation that the transaction read
   (`apps/backend/src/http-api/receipt-transaction.ts`). The revision that the
   command carries, `expectedRevision`, is a check of the runner. It runs
   before the check of the legal transition, so a stale revision keeps its own
   typed failure. It cannot be a guard on an edge: a command that the state
   does not list has no edge to carry the guard, and a guard on the edges gives
   the failure of an illegal transition where `decideReceipt` gives the stale
   revision (mutation M7a of the second spike). Today `decideReceipt` fails in
   this order: decode, missing receipt, authority, existing receipt on submit,
   stale revision, illegal transition
   (`packages/domain/src/receipt/update.ts:192-202,243-245`). The runner keeps
   that order while the legacy decider exists. The runner also holds two
   facts about commands that the machine does not own: submit creates a
   receipt, and every other command needs the receipt before authority can run.
6. The actor runs inside the transaction scope. It runs inside `runCommand`
   once that exists. Until then it runs inside the `execute` effect of
   `executeNativeHttpCommandPostgres`, which retries once on a serialization
   failure when the caller asks for it
   (`apps/backend/src/http-api/receipt-transaction.ts:316-322`). A retry
   rebuilds the actor from a fresh read and a fresh authority resolution. No
   actor, snapshot, or authorization result survives a retry.
7. The database row stays the truth. This specification persists no XState
   snapshot. The machine starts in a state that reads the loaded row, and it
   moves at once, by an eventless transition, to the state that matches the
   status of the row. The `snapshot` option of `createEffectActor` resumes a
   persisted snapshot, but it restarts every Effect task that was running
   (declaration of `@xstate/effect` 0.1.0-alpha.7). That does not fit a short
   command inside a transaction. Each lifecycle in the table above also keeps
   its state in a column, or derives it from columns.
8. These stay outside the machine: the authority policy, the HTTP receipt and
   precondition, the clock (the command carries `now`), and delivery.

### Departure from the consolidation draft

This decision departs from `docs/specs/architecture-consolidation.md`.
Principle 4 (`:47-52`) allows an actor only where state bound to operations is
a real requirement, and the requirement must be named. The paragraph after the
principles (`:58-61`) ranks a pure function before a service, a service before
an actor, and an actor before a queue. This specification puts an actor in the
path of every command. The operator accepts the departure.

The named requirement is this: the legal transitions of a lifecycle must exist
as data. Tests walk that data to show reachability. A check compares it with
the SQL status sets. A server projection reads it to list the allowed actions.
A `decide` function cannot supply this.

The actor is short-lived. One actor serves one command, inside one transaction.
It holds no state after the command. It uses no queue.

The cost is an actor and an interpreter loop for each command, in place of a
function call. The spikes measured it on the receipt lifecycle with a no-op
write, so no database time is in the numbers. Medians over nine rounds, in
microseconds per command: 12.35 for `decideReceipt`; 252 for the first
machine, which lists refusal edges; 288 for the legal-only machine (23.3
times `decideReceipt`); and 53 to 56 for either machine alone as a pure
`transition`. A refused command costs about 49 for the legal-only runner,
because it stops before it sends an event. The actor adds roughly 240 to 275
per command. Neither spike compared that with the cost of a serializable
PostgreSQL transaction. The spikes also found no code reduction. The
transition logic of the legal-only machine is about 230 lines, 262 with the
runner preconditions, against about 197 for `decideCommand` and its guards.
The machine repeats about 130 lines of data rules, because the spike did not
let it call `decideReceipt`. The Spike evidence section has the details.

The machine does not depend on the actor. `xstate` exports a pure `transition`
function over the same machine. The actor form can change without a change to
the machine, the tests, or the derivations.

The departure also changes the reading of falsifier 4 of the consolidation
draft (`:751-752`), "the decision is pure". The guards and the assigners of a
machine are pure. The runner has `Tx` in its requirements, because a declared
actor records the decision. Falsifier 4 of this specification replaces it for
machines.

If the operator approves this draft, two statements need an edit.
`docs/architecture.md:179` says that the boundaries need no state runtime. The
paragraph after the principles of the consolidation draft ranks an actor below
a function. This draft changes neither.

## Derivations

`AGENTS.md#construction-over-trust` requires that a copy of a derived value is
generated from its source, or checked against it. Each fact below has one root.

| Fact | Root | Derivation | Rung |
| --- | --- | --- | --- |
| Set of status names in TypeScript | The literal schema, for example `ReceiptStatusSchema` | A test per lifecycle compares the lifecycle states of the machine with the literal schema | Test |
| Set of status names in SQL | The states of the machine | A test per lifecycle compares the CHECK set with the machine states. It reads the migration chain now and the context schema declaration after the schema collapse. | Test |
| OpenAPI status enums | The same literal schema | Stay generated by the HTTP contract (`AGENTS.md`: generate HTTP, OpenAPI, and SDK artifacts from the existing contract) | Generate |
| Reachable states and final outcomes | The machine | `getShortestPaths` and `getPathsFromEvents` of `xstate/graph` feed the model tests. No test writes the table of transitions by hand. | Generate |
| Allowed actions in Foldkit | The machine | A server projection of `snapshot.can` over the hydrated snapshot. It replaces `actionMatchesObservation` and the rules of the decision form. For the receipt machine, `getNextTransitions`, `snapshot.can`, and `isUnhandled` of `transition` all equal an independent table in all 30 cells. A stale revision and authority are runtime preconditions, not part of availability. The projection needs a decision context that availability ignores. No projection function, HTTP contract, or Foldkit consumer exists yet. That is a later change to the HTTP contract and the generated SDK, and it is not part of the first version. | Test |

When the projection is built, a test feeds each command event to the hydrated
snapshot with `transition` and `isUnhandled`. It compares the events that the
snapshot accepts with the projected set. Content already follows the pattern
with `canPublish` and `canRevise`.

## Order

One lifecycle moves in one slice, as one clean cutover. A slice adds the
machine beside the legacy decider, proves equivalence (falsifier 1), switches
every caller, and then deletes the legacy decider and its equivalence test. No
shim stays. A slice starts after the falsifiers of the slice before it pass.

1. Receipt, the pilot. It starts after `feat/effect-stable-v4` lands. The legal
   table of the pilot is the table that `decideReceipt` enforces. A missing
   receipt accepts submit. A `Pending` receipt accepts revise, withdraw,
   approve, and reject. A `Rejected` receipt accepts reopen. An `Approved` or
   `Withdrawn` receipt accepts nothing
   (`packages/domain/src/receipt/update.ts:209,243-245,319-328`). The pilot does
   not wait for `runCommand` if it declares its own transaction service (see
   Dependencies).
2. Interview invitation and interview conduct.
3. Placement proposal and dated service decision. The decision rules leave the
   database adapter (`packages/database/src/placements/coverage.ts:527-582`) in
   this slice.
4. Admission outcome.
5. Onboarding invitation and delivery.
6. Outbox envelope, last. It moves only together with step 4 of the
   consolidation draft (one delivery mechanism, section 9) and with the Workers
   S2 triggers. Otherwise the machine would encode the claim mechanism that
   those two changes replace.

This order does not schedule affiliation, account access, content article,
appointment, or delegation. Appointment and delegation derive their state from
an interval and an instant (`packages/domain/src/organization/lifecycle.ts:188-192`,
`packages/domain/src/authz/delegation.ts:236-240`). The operator decides on the
others after the second slice.

## Dependencies

- Stable Effect. The specification `docs/specs/effect-stable-v4.md` exists on
  the branch `feat/effect-stable-v4` only. Main pins `effect` at `4.0.0-rc.116`
  in the root catalog (`package.json`, `catalogs.effect-v4`). That version sorts
  before 4.0.0 in semver, so it does not satisfy `^4.0.0`, the peer range of
  `@xstate/effect` 0.1.0-alpha.7. The branch pins `effect` at `4.0.0`. The pilot
  waits for the branch to land.
- `runCommand` and `Tx`. `docs/specs/commands-and-concurrency.md` freezes both
  (`:23-25`). Neither exists on main: the source of `packages/database`,
  `packages/domain`, and `apps/backend` has no `Tx` service, and the name
  `runCommand` belongs only to unrelated local helpers. If the pilot starts
  first, it declares its own transaction service and provides it from the
  transaction that `executeNativeHttpCommandPostgres` opens. `runCommand` then
  becomes the provider, and the machine does not change.
- Prerelease pins. `xstate` 6.0.0-alpha.65 and `@xstate/effect` 0.1.0-alpha.7
  are the versions examined on 2026-10-10. `@xstate/effect` declares the peers
  `effect ^4.0.0` and `xstate ^6.0.0-alpha.65`. rat-stack pins the same two
  versions in `@rat-stack/core` ([pins](https://ratstack.sh/pins.md)). The root
  catalog owns the versions after adoption (`AGENTS.md`).
- Exception. Both packages are prereleases. The pilot slice registers an entry
  in `docs/effect-exceptions.json` for them. The entry names the native
  alternatives that the installed Effect guidance offers, its owner, the
  versions of both packages and of `effect` in `examinedWith`, and the
  retirement trigger: xstate 6.0.0 stable and `@xstate/effect` 0.1.0 stable.
  `just exceptions` reopens an entry when a pinned version changes, so every
  alpha bump reopens it.
- Peer check. `AGENTS.md` requires a peer check before adoption. Main fails the
  Effect peer. `feat/effect-stable-v4` satisfies both peers, with `effect`
  4.0.0 and the exact `xstate` pin.
- Inline Effect. rat-stack rejects an inline Effect in a machine callback with
  the lint rule `xstate-effect/no-inline-effect`. The pilot slice ports that
  rule (see the rat-stack section) or records why none is needed.
- Outbox envelope. The last step waits for the delivery mechanism of the
  consolidation draft and for `feat/workers-s2-delivery`. Its specification,
  `docs/specs/workers-s2-delivery.md`, exists on that branch only.

## rat-stack as the reference

Operator decision, 2026-10-10: use rat-stack as the reference for how this
repository builds. `AGENTS.md` already names it the architectural reference.
This specification follows the skill
[add a lifecycle machine](https://ratstack.sh/skills/add-a-lifecycle-machine)
and the principles `keep-unknown-distinct`, `tests-detect-broken-behavior`,
`prove-move-delete`, and `subtract-before-you-add`. The `@rat-stack/*`
packages are workspace packages of the rat-stack template. A check of the npm
registry on 2026-10-10 returned 404 for `@rat-stack/core` and
`@rat-stack/capability`. This repository copies a pattern, and ports a rule
with the MIT notice of rat-stack. It does not install a package.

rat-stack covers lifecycles, the lint fence, and the test method. It has no
command transaction runner, no receipt or audit table, and no outbox delivery.
Its store skill says that its port has no atomic multi-write operation. Those
constructs stay in this repository, as consolidation sections 8 and 14
describe.

The spike checked against the skill:

| Pattern | Result |
| --- | --- |
| Effects live in declared `fromEffect` actors, and `setupEffect` declares them | Followed. |
| `createEffectActor` runs inside `Effect.scoped`, from `Effect.fn` | Followed. |
| A known refusal is a typed outcome | Differs, on purpose. The first spike followed the skill: a final outcome in a typed union (`Decided` or `Refused`). The legal-only machine has one final state, `decided`, and the runner raises the refusal as a typed failure before it sends the event. That keeps the projection honest. `keep-unknown-distinct` still holds: a typed failure is a refusal, and an actor error is a defect. |
| An actor error is not turned into a final state (`keep-unknown-distinct`) | Followed. `persisting` has no `onError`, and a failed write is a defect. |
| Wait with `join` and `Effect.orDie`, behind one diagnostic override | Differs. The spike waits with `waitFor`. In this repository the override needs an entry in `docs/effect-exceptions.json`. The spike keeps `waitFor`, so no entry is needed. |
| `watchActor` shows each actor to the devtools | Not adopted. It comes from `@rat-stack/capability`, which is not published. |
| A model test with `getShortestPaths`, then generated histories through `getPathsFromEvents`, with child completion driven by a `Deferred` fake, and a probe after completion | Partly followed. The spike uses `getShortestPaths`, a `Deferred` in the cancellation test, and an equivalence property against the legacy decider. It has no generated histories through `getPathsFromEvents` and no probe after completion. The pilot slice adds the model test from `skills/add-a-lifecycle-machine/templates/lifecycle.model.test.md`. |
| Plant a bug before trusting a property | Followed. Seven mutations, as the Spike evidence section lists. |
| `xstate-effect/no-inline-effect` blocks an inline Effect in a machine | Not yet. The rule is the file `scripts/oxlint-plugin-xstate-effect.ts` of rat-stack (MIT). The pilot slice ports it into `tools/oxlint` with the notice, or records why not. |
| Prove the replacement, move the callers, delete the old path (`prove-move-delete`) | Matches the Order section. A slice proves equivalence, switches every caller, and deletes the legacy decider. |
| Subtract before adding (`subtract-before-you-add`) | Followed in the plan. `admission_period_outbox` is written and never read (consolidation section 14). Deleting it is item 1 of the ranked order in section 14, before the pilot. The operator has not approved consolidation decision 6, which that deletion needs. |

When a check and this text disagree, the check wins and this text changes. That
is the rule of the rat-stack fence.

## Falsifiers

Each check fails when the property breaks, and each has a negative control.

1. Equivalence. For each lifecycle, a property test runs generated command
   sequences through the legacy decider and through the machine runner. The
   results must be equal: the same success value, or the same failure tag and
   fields. The test runs until the legacy decider is deleted. Negative control:
   falsifier 6.
2. Reachability. With `getShortestPaths` of `xstate/graph`, every state of a
   machine is reachable, and every final state is reached. Negative control: a
   state without an inbound transition fails the check.
3. One set of states. For each lifecycle, a test compares the states of the
   machine with the TypeScript literal schema and with the SQL CHECK set.
   Negative control: add a value to the CHECK set, and the test fails.
4. Transaction-only requirements. A type test compares `RequirementsFrom` of
   each machine with the transaction service. A machine whose actor requires
   `Mail`, an HTTP client, or a file store fails `tsc`. Negative control: such a
   machine in the test file.
5. Real PostgreSQL. A stale revision and a concurrent second command produce
   the typed failures of today. The test runs on a disposable cluster
   (`startDisposablePostgres`) under `just measure`. Negative control: remove
   the revision guard, and the stale-revision test fails. Remove the
   serialization retry, and the concurrent test fails.
6. Mutation check. Before a slice trusts falsifier 1, break one rule of the
   machine, for example let `Approved` accept `RejectReceipt`. Run the tests.
   Record the shrunk counterexample in the evidence of the slice, outside the
   repository. Restore the machine, and run the tests again. The property must
   fail on the mutation. This is the negative control of falsifiers 1 and 2.
7. Availability. For each lifecycle, a test compares the commands that the
   hydrated snapshot reports as available (`getNextTransitions` and
   `snapshot.can`) with an independent table that the test writes from the
   legacy decider. A stale revision and authority are not part of the table.
   Negative control: the same test on a machine that lists a refusal edge for
   every command fails. The equivalence tests alone do not see an illegal edge
   that the runner refuses first (mutation M4 of the second spike).

## Spike evidence

The spikes are throwaway and do not land. Branch `spike/receipt-lifecycle-actor`,
based on `d2ad39df` (`feat/effect-stable-v4`, Effect 4.0.0). Commit `26a99b8c`
adds `packages/domain/src/receipt/lifecycle.ts` and `lifecycle.test.ts`: a
machine that lists a refusal edge for every command (the first spike). Commit
`158fa281` adds `lifecycle-legal.ts` and `lifecycle-legal.test.ts`: a machine
that lists only legal events (the second spike). Neither commit changes an
existing receipt file. The raw evidence stays outside the repository, in
`/srv/share/projects/vektorprogrammet/lifecycle-spike-evidence/RESULTS.md`
with numbered logs.

### First spike: refusal edges

| Question | Result |
| --- | --- |
| Does `@xstate/effect` 0.1.0-alpha.7 install with `xstate` 6.0.0-alpha.65 on Effect 4.0.0? | Yes. There was no peer conflict, and one `effect@4.0.0` copy is shared. Main stays on `4.0.0-rc.116`, which does not satisfy the peer range. The peer check on main was not run. |
| Can the machine express guard-ordered typed refusals? | Yes, as refusal edges inside the machine. The pure `transition` fallback was not needed. The second spike moves the refusals out of the machine. |
| Is it equivalent to `decideReceipt`? | Yes on a property of 200 runs (551 steps, seed 22082034) and on an exhaustive grid of 600 cells, with 0 failures. The machine does not call `decideReceipt`. |
| Do the tests detect a broken rule? | Yes. The required mutation, `approved` accepts `RejectReceipt`, fails the property with a shrunk counterexample: an approved receipt, then `RejectReceipt`. Six further mutations were caught. All were reverted. |
| Are all states reachable? | Yes. `getShortestPaths` of `xstate/graph` reaches all 9 states and exactly the two final states. The machine states equal the receipt status literals. |
| Does `tsc` reject a machine that needs another service? | Yes. A machine that requires `Mail` fails `tsc`. `RequirementsFrom` of the receipt machine equals the transaction service. |
| Cost | 12.2 us, 263 us, and 53 us per command in that session, as in the Decision section. Bun 1.3.10, one machine, a no-op write. |

Findings that change this contract:

1. The allowed-actions projection does not come for free from a machine with refusal edges. The second spike fixes it with legal-only edges.
2. `join` does not pass the house lint. See the Decision section.
3. The machine is not shorter than the function. It makes the legal-transition table data, which tests, graph walks, and the type check use. The function does not.
4. The legacy decider returns `ReceiptNotFound` before `InactiveActor` for a non-submit command on an absent receipt. The first runner skips the authority check on an absent receipt and lets the machine refuse. The grid pins this order.
5. The spike used `Effect.result` in the tests instead of `Effect.exit`, and starts the property from any status.

Not exercised: PostgreSQL, a real transaction or `runCommand`, serialization
retry, concurrency, HTTP, idempotency receipts, the ETag check, mail, file I/O,
persisted snapshots, a Cloudflare Worker bundle, `just check`, `just test`, and
hosted CI. The authority check is the pure `authorizeReceiptMutationAccess`
over fixtures.

### Second spike: legal-only edges

Commit `158fa281`. Each state lists only the events that are legal in it:
absent accepts submit, `Pending` accepts revise, withdraw, approve, and reject,
`Rejected` accepts reopen, and `Approved` and `Withdrawn` accept nothing. The
machine has no refusal edge and one final state.

| Question | Result |
| --- | --- |
| Is it equivalent to `decideReceipt`? | Yes. The property (200 runs, 551 steps, seed 22082034) and the grid of 600 cells show 0 failures. Failures compare by tag, fields, and message. |
| Does the machine give the projection? | Yes. For the 5 starts (absent and the 4 statuses) and the 6 commands, `getNextTransitions`, `snapshot.can`, and `isUnhandled` of `transition` equal a table that the test writes from `update.ts`, in all 30 cells. |
| Does the projection test detect a refusal-edge machine? | Yes. The same check on the first machine reports exactly the 24 refused cells as available. |
| Where does each refusal live? | The runner raises decode errors, `ReceiptNotFound`, the stale revision, `InvalidReceiptTransition`, and `ReceiptAlreadyExists`. `authorizeReceiptMutationAccess` raises the authority failures. The machine holds no refusal. |
| Do the tests detect a broken rule? | Yes. Mutations: `approved` lists `RejectReceipt` (counterexample: pending, approve, then reject); `pending` loses withdraw; the runner checks legality before revision; `absent` lists approve; `hydrating` sends `Withdrawn` to `approved`; the runner never checks legality; the stale guard moves onto the edges. All were caught and reverted. |
| Cost | 288 us per command, 23.3 times the 12.35 us of `decideReceipt`, and 14 percent more than the first runner (252 us in the same session). `snapshot.can` costs about 0.3 us over the 19.9 us of hydration. `isUnhandled` of `transition` costs about 34 us more. |

Findings:

1. The projection check is the only test that sees the absent row for commands other than submit. The runner answers `ReceiptNotFound` before it asks the machine, so the property and the grid pass when `absent` lists approve (mutation M4). Every lifecycle needs its projection test.
2. Unlisted events vanish. The actor stays active, with no dead letter, and a runner that skips `can` hangs (mutation M6, found only through the timeout). The check belongs in the shared runner.
3. The legal table lives once for the status rows. The runner still holds two facts about command shape, as the Decision section states, and the spike found no way to reproduce the order of `decideReceipt` without them.
4. The typestate narrowing that the first spike could not get for hydration works when `hydrating.always` returns a union of whole transition objects. The first spike's probe was not rerun, so other differences are unknown.
5. The projection needs a decision context (id, visual id, and `now`) that availability ignores. Putting the context in the event would make `initialTransition` over the existing receipt the whole projection. The spike did not build that.

Not exercised, in addition to the list above: a projection function, an HTTP contract, a Foldkit consumer, and `snapshot.can` on edges that are functions. The mutations M1 to M6 ran before the last test was split in two, and were not rerun against the final test file. The data rules and the decoders are copies, so equivalence holds for the copies.
