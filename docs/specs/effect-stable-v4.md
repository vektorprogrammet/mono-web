# Stable Effect consumer cutover

Status: approved, frozen for local implementation on 2026-10-09.

## Goal and source boundary

Upgrade the existing native application and its effx authoring/generation surface to stable Effect v4 without adding feature behavior. The canonical branch is `feat/effect-stable-v4`, based on clean `a41ede768f12ec81340bd98ae650fc70ef6552c4`, in the registered `mono-web-stable-v4` worktree. Main, active feature worktrees, unpublished feature sources, and historical proof snapshots remain unchanged. No merge, push, deployment, provider, credential, or production-data changes are authorized.

## Required behavior

- The root catalog and Bun lock own the exact stable application cohort and compatible Foldkit/UI/Vite peers. Infrastructure retains its separately compatible graph. Active imports and compiler configuration use real installed stable APIs, not aliases or RC holdouts.
- Consume only the stable-only effx compiler owner's published artifacts with actual commit, manifest, and hashes. Regenerate contracts, handlers, HTTP/OpenAPI, SDK, and applicable Foldkit output through existing commands; generated output is never patched by hand.
- Inspect public stable upstream before porting the HttpApi ClientRequest union and PersistedQueue migration verification/ack retry fixes. Preserve their semantics and regression evidence; renaming a patch is not retirement.
- Implement the already approved [native PostgreSQL driver](native-postgres-driver.md) seam through a separate SQL writer: two scoped pools, native Database (at most eight connections), supported Better Auth pg/Kysely (at most four). The 2026-10-09 parent clarification withdraws the earlier one-pool mandate. No custom Kysely/Auth shim or private API. Transactions, codecs, cancellation, migration parsing, and shutdown must preserve native behavior. A Worker connection-budget amendment needs explicit local documentation and native capacity/cancellation evidence, not provider mutation.
- Reopen and re-examine affected exceptions, update authoritative guide sources and patch records, and remove obsolete RC paths after complete cutover.
- Active effx-related feature owners consume the exact published migration in their own trees. Root/Worker features enter this branch only through owner-published source commits. Upgrading the existing application does not certify unfinished features.

## Acceptance

Acceptance binds to fresh frozen installation of clean committed source, its actual installed versions, and an external file manifest. Run serial full check, types with Effect diagnostics, lint, conventions, tests, builds, and generated/compiler semantic contracts through the repository's supervised devenv/just measure commands. Exercise actual UI, API, PostgreSQL, Better Auth transaction failure/interruption, pool capacity and cleanup, and native Worker behavior if included. Existing real native journey helpers are authoritative; mocks and historical RC results are not acceptance.

The lift producer receives a new immutable public stable source snapshot and oracle derived from the actual migration revision/file manifest. Preserve original `f433`/`8152` source and oracle provenance separately. Report exact source commits, installed versions, commands, real smoke receipts, and every unverified provider boundary. Evidence stays outside the repository. Stop only task-owned resources. Remove this active contract only after complete local acceptance is represented by source, system/architecture documents, and executable checks.
