# Goal-1 design spec 0024 — zero-gap functional parity inventory

> **Summary:** One maintainer journey reads the legacy application and the current `mono-web` line, derives seven schema-validated JSON inventories, and emits a deterministic zero-gap report. The report accounts for route, operation, write, workflow, integration, and user-journey coverage. It preserves source authority, source revisions, exact hashes, static/runtime disagreement, duplicates, dead or unimported declarations, and stale projections. It does not decide business intent and it does not prove behavior parity.

## Metadata

| Field | Value |
|---|---|
| Goal | Goal-1 machine-readable functional-parity inventory |
| Contract | `functional-parity-inventory/v1` and `functional-parity-zero-gap-report/v1` |
| Specification status | `Accepted` on `2026-08-20`. This records acceptance of the specification only. |
| Lifecycle state | `Drift` |
| Dependency | 0023 functional-parity integration baseline at `462691d4c31ed601fba01f8b5f21abb92a547ff9` |
| Spec worktree | `/tmp/mono-web-parity-inventory-spec-0024` |
| Spec branch | `spec/0024-zero-gap-parity-inventory` |
| Implementation candidate | `Unaccepted`. Path `/tmp/mono-web-parity-integration-0023`, branch `impl/0023-functional-parity-integration-baseline`, head `ed2f2c10088c03de607bcc08fe6797a4343daaf1`. |
| Candidate relation to `main` | 0 commits behind and 57 commits ahead of `main`. |
| Current writer mutation | The specification worktree owns only `design-specs/0024-zero-gap-functional-parity-inventory.md`. `PhpTriviaEngineer` owns only `packages/parity-inventory/src/php-trivia.ts`, `packages/parity-inventory/src/routes.ts`, `packages/parity-inventory/src/api.ts`, and `packages/parity-inventory/tests/falsifiers.test.ts` in `/tmp/mono-web-parity-integration-0023`, plus the required commit integrations. |
| Active production writer | `PhpTriviaEngineer`, bound to `/tmp/mono-web-parity-integration-0023` during the bounded PHP declaration-trivia repair |
| Legacy input | Read-only legacy repository evidence; the inventory command never writes to it |
| Current mono input | `mono-web` at an explicitly selected full revision; the deterministic mono authority revision is a canonical tracked-blob file-set digest that excludes the owned derived projection mount; raw Git `HEAD` is execution provenance only |
| Required execution mode | `frozen` source mode for parity output; `fixture_injection` is exposed only through a named `--falsifier F0_...` run and never writes committed projections |
| External effects | None. No provider, production, database, credential, or route action is authorized |

This document is the accepted contract for a future implementation. The candidate named in Metadata is implementation evidence only and is not accepted. This document does not accept a route, remove a declaration, approve an integration, or make a business ruling.

## Reconciliation status and Drift log

Specification acceptance was recorded on `2026-08-20`. The acceptance covers this contract only. The current lifecycle is `Drift`.

### `D-0024-IMPLEMENTATION-RECONCILIATION`

- **Observation and conflict:** The previous metadata said `Specified`. The observed candidate already contains the C0–C3 implementation and later fixes. The specification and implementation therefore had different lifecycle facts.
- **Prior candidate observation:** The original candidate was `/tmp/mono-web-parity-integration-0023` on branch `impl/0023-functional-parity-integration-baseline` at full head `27be6aa73c185ab30a7de138d399190bd68ebe18`. It was 48 commits ahead and one commit behind `main`. Its main-only commit was `bebab18258da5a0f993dfcc6f09ea5e8af7bf68e` (`fix(dashboard): align React Router and React versions`). This remains preserved evidence.
- **Previous candidate observation:** The candidate later reached full head `9fd81ec449ddc7e085d1cf90e0243eff66385bdc`, at 0 commits behind and 53 commits ahead of `main`. This remains preserved evidence.
- **Previous candidate observation:** The candidate then reached full head `e93a5b1d7bcfe289e154a55aaa4e3cc38e4009d6`, at 0 commits behind and 55 commits ahead of `main`. This remains preserved evidence.
- **Current candidate:** The unaccepted candidate is `/tmp/mono-web-parity-integration-0023` on branch `impl/0023-functional-parity-integration-baseline` at full head `ed2f2c10088c03de607bcc08fe6797a4343daaf1`. It is 0 commits behind and 57 commits ahead of `main`.
- **Preserved evidence:** Preserve the candidate worktree, exact commit graph, C0–C3 implementation commits (`dced46f`, `0a56bd0`, `922b61b`, and `0cd4224`), later fixes through the current exact head, package schemas, and tests. Treat this material as observation only.
- **Disposition:** Keep this specification authoritative. Keep the candidate reusable but unaccepted. Do not alter the inventory contract, its falsifiers, or its zero-gap predicate. Do not treat implementation code, tests, or later fixes as historical acceptance.
- **Owner:** `Main` (product lead) owns reconciliation, verification, and candidate acceptance or rejection. `ParityRecoveryEngineer` owns only the prior bounded repair capsule. `CollectorRuntimeEngineer` owns only the Nix PHP runtime repair capsule. `OpenApiSafetyEngineer` owns only the OpenAPI safety repair capsule. `PhpTriviaEngineer` owns only the PHP declaration-trivia repair capsule below.
- **Return gate:** Return from `Drift` only when all conditions hold:
  1. Explicitly integrate `bebab18` (`bebab18258da5a0f993dfcc6f09ea5e8af7bf68e`) or record an explicit disposition that names why 0024 does not integrate it.
  2. Complete the exact-head isolation repair. Record the repaired full head, clean worktree, and isolated source and projection inputs.
  3. Run objective deterministic verification at the repaired exact head against identical pinned inputs. Retain the deterministic byte comparison, schema and invariant results, and falsifier receipts.
  4. Do not invent historical acceptance. Record any candidate acceptance only after this gate, with an explicit date, owner, exact head, and evidence.

### Bounded repair capsule `D-0024-REPAIR-EXACT-HEAD`

This capsule stays inside `Drift`. It does not accept the candidate or change the inventory contract.

- **Writer:** `ParityRecoveryEngineer`, bound to `/tmp/mono-web-parity-integration-0023`.
- **Required integrations:** Integrate `bebab18` (`bebab18258da5a0f993dfcc6f09ea5e8af7bf68e`). Integrate the current head of `spec/0024-zero-gap-parity-inventory`, which contains accepted commit `7df51f0f3ed1610b2da922572830bfb709bc6db1` and its reconciliation amendments.
- **Allowed repair:** For the repair delta, modify only `packages/parity-inventory/tests/c2.test.ts` to use an isolated local clone at the exact candidate head. Do not modify another file.
- **Commit:** Commit the bounded repair after the required integrations. Record the resulting full head and clean worktree.
- **Verification and decision:** `Main` alone runs verification and accepts or rejects the candidate. The writer must not run tests, build, or lint.

### `D-0024-NIX-PHP-RUNTIME`

- **Observation and conflict:** At candidate head `9fd81ec449ddc7e085d1cf90e0243eff66385bdc`, the canonical Nix PHP 8.4 runtime is `/nix/store/4b43fhs9a4d3xx52qng4hvijzaqqzgc4-php-with-extensions-8.4.23/bin/php`. The file is regular, immutable, executable, and required for Symfony. `collectorExecutableProvenance` accepts only `-php-` paths, so it rejects the required `php-with-extensions-*` path.
- **Rejected substitute:** The accepted unwrapped path is `/nix/store/f0p4v11a77h2rd90kqs9n225fk6vn580-php-8.4.23/bin/php`. It lacks the required extensions. `bin/console --version` fails with undefined `filter_var`.
- **Disposition:** Keep the lifecycle in `Drift`. Accept the immutable Nix `php-with-extensions-*` canonical shape. Preserve rejection of arbitrary, relative, symlinked, noncanonical, writable, and non-executable paths.
- **Writer:** `CollectorRuntimeEngineer`, bound to `/tmp/mono-web-parity-integration-0023`.
- **Required integration:** Integrate the current head of `spec/0024-zero-gap-parity-inventory` before the repair.
- **Allowed repair:** Modify only `packages/parity-inventory/src/api.ts` and `packages/parity-inventory/tests/collector-config.test.ts`. Do not modify another file.
- **Verification and decision:** `Main` owns focused validation and the real Symfony collector smoke. The writer must not run tests, build, or lint. The candidate remains unaccepted until `Main` records its disposition.

### `D-0024-OPENAPI-COMPONENT-KEYS`

- **Observation and conflict:** At candidate head `e93a5b1d7bcfe289e154a55aaa4e3cc38e4009d6`, real offline collectors stage and execute with immutable PHP and vendor inputs. OpenAPI export fails closed because generic structured safety treats component schema registry names `PasswordChangeInput`, `PasswordResetExecute`, and `PasswordResetRequest` as secret-bearing keys. No individually scanned leaf scalar is unsafe. These names are schema identifiers, not values.
- **Required projection boundary:** Structurally project arbitrary OpenAPI component registry entry names before the generic safety scan. Do not create an observed-name allowlist. Continue scanning component values.
- **Blocking safety contract:** Concrete secret-bearing `example`, `examples`, `default`, `defaults`, `value`, `values`, `const`, and `enum` content under sensitive schema properties must remain blocking. Existing route-key and schema-property-name handling must remain.
- **Disposition:** Keep the lifecycle in `Drift`. Keep the candidate unaccepted. Do not weaken the generic safety boundary.
- **Writer:** `OpenApiSafetyEngineer`, bound to `/tmp/mono-web-parity-integration-0023`.
- **Required integration:** Integrate the current head of `spec/0024-zero-gap-parity-inventory` before the repair.
- **Allowed repair:** Modify only `packages/parity-inventory/src/api.ts` and `packages/parity-inventory/tests/falsifiers.test.ts`. Do not modify another file.
- **Verification and decision:** `Main` owns focused tests and the real collector rerun. The worker must not run validation. The candidate remains unaccepted until `Main` records its disposition.

### `D-0024-PHP-DECLARATION-TRIVIA`

- **Observation and conflict:** At candidate head `ed2f2c10088c03de607bcc08fe6797a4343daaf1`, `Main` verified the OpenAPI repair with a focused falsifier: 1 pass, 66 filtered, and 0 fail. The exact-head real collector now succeeds. Both `api_platform_metadata` and `openapi_projection` are `available`, with exit 0 and immutable `nix-store` PHP and bwrap provenance. The inventory has 657 unresolved rows and no runtime-unavailable failures.
- **Remaining parse error:** One `SOURCE_PARSE_ERROR` points to valid PHP `apps/server/src/App/Identity/Api/Resource/ProfilePhotoInput.php`. `php -l` accepts the file. The cause is that `api.ts` class matching allows only whitespace between the closing attribute and class modifiers, but this file has a docblock there.
- **Required contract:** API-resource declaration scanning must skip PHP whitespace, `//`, `#`, and `/* ... */` comments between the closing attribute and class modifiers. An unterminated block comment must fail closed.
- **Shared scanner boundary:** Reuse one shared PHP-trivia scanner by extracting the existing `routes.ts` helper. Do not add a second parser.
- **Writer:** `PhpTriviaEngineer`, bound to `/tmp/mono-web-parity-integration-0023`.
- **Required integration:** Integrate the current head of `spec/0024-zero-gap-parity-inventory` before the repair.
- **Allowed repair:** Modify only `packages/parity-inventory/src/php-trivia.ts` (new), `packages/parity-inventory/src/routes.ts`, `packages/parity-inventory/src/api.ts`, and `packages/parity-inventory/tests/falsifiers.test.ts`. Do not modify another file.
- **Regression:** Add a regression with a docblock between the attribute and class. Add a malformed-comment falsifier.
- **Verification and decision:** `Main` owns focused tests and the real collector rerun. The worker must not run validation. The candidate remains unaccepted until `Main` records its disposition.

## Scope and non-goals

### Goal

Give one maintainer one command that answers these questions from exact, hash-bound inputs:

1. Which legacy route declarations and controller annotations exist?
2. Which mono routes and API operations exist at the selected revision?
3. Which custom commands and source-level write paths exist on both lines?
4. Which scheduled or background workflows are declared, imported, and observable?
5. Which external integrations and call sites exist on both lines?
6. Which accepted user-journey references cover each parity-relevant row?
7. Which rows match, are missing, are extra, are changed, are duplicated, are stale, are dead or unimported, or remain unresolved?
8. Which mismatches have an immutable accepted-intent reference, and which remain gaps?

The command produces deterministic artifacts and a separate timestamped execution-evidence envelope. It regenerates the artifacts in a temporary directory, schema-validates them, compares them with the committed projection, and exits nonzero when the report is not zero-gap.

### Non-goals

This lane does not:

- implement routes, controllers, resources, commands, workflows, adapters, or user journeys;
- change a route, API operation, OpenAPI file, source declaration, provider configuration, or production system;
- infer that a route is public, safe, equivalent, obsolete, or approved;
- replace an accepted-intent record with a count, route name, method, successful parse, or runtime reachability;
- call external integrations or production endpoints;
- run a migration, seed a database, use credentials, or access a raw backup;
- prove response behavior, authorization, data correctness, performance, accessibility, visual parity, or business parity;
- treat a roadmap, dashboard, copied table, committed OpenAPI file, H3 packet, or route contract as a parity authority.

The final statement of this spec is normative: **a zero-gap inventory proves coverage accounting, not behavior parity.**

## Authority and evidence boundary

Each input has one authority role. The generator keeps authority, observation, derivation, intent, and execution evidence as separate relations.

| Concern | Sole authority or evidence | Boundary |
|---|---|---|
| Legacy declarations | The selected immutable legacy source revision and its files | Read-only source authority for legacy declarations; no acceptance of future behavior |
| Mono declarations | The selected immutable mono source revision and its files | Source authority for current declarations; no claim that source is correct |
| Resolved mono routes | A local runtime route collector executed at the selected revision | Runtime observation; it cannot replace source provenance |
| Resolved API operations | API Platform metadata/runtime observation at the selected revision | Runtime observation; it cannot replace resource source files |
| Committed OpenAPI | `packages/sdk/openapi.json` at the selected revision | Generated projection only; it is never an operation authority |
| Source manifests | The generator's byte manifest over named source sets | Exact input accounting; a manifest hash proves identity, not correctness |
| Accepted intent | An immutable external or repository intent reference with revision and hash | May disposition a missing, extra, renamed, split, merged, or intentionally absent row; it cannot waive unresolved, stale, duplicate, or uncovered state |
| User-journey coverage | Accepted journey references and their immutable source hashes | Coverage relation only; it does not prove the journey ran or behaved correctly |
| Runtime evidence | A separately retained execution-evidence record | Time, host, command, and runtime details; it is not part of deterministic artifact bytes |
| H3 security inventory | H3 route/resource artifacts and generator as derivation inputs only | Reusable route/resource derivation; never parity authority and never copied as a verdict |
| Preview route contract | `infra/preview/routes/route-contract.ts` and its projection | Preview deployment scope only; not a functional-parity inventory authority |

A hash proves which bytes the generator read. It does not grant authority to the bytes, authenticate an operator, or prove a semantic claim.

### Dependency on the 0023 integration baseline

Implementation verification MUST start from the 0023 integration baseline at full revision `462691d4c31ed601fba01f8b5f21abb92a547ff9`, or from a later explicitly named revision that records the baseline as its parent. A maintainer MUST NOT silently verify against a different checkout, a dirty source tree, or a branch that has not recorded the baseline relationship. The baseline is an input boundary, not a parity result.

The legacy evidence revision observed while this spec was drafted is `d05c261e9f73297f70ad228635c85ab566c51526`. An implementation records the actual selected legacy revision in its source manifest and fails on missing, unreadable, or changed source bytes. This value is provenance, not a permanent count or acceptance rule.

## Current observations, not schema truth

The following values are current observations from the named evidence lines. They are useful for planning and falsifiers only. They MUST NOT appear as JSON Schema `const`, `minItems`, `maxItems`, or expected-count rules.

| Observation | Current value | Contract treatment |
|---|---:|---|
| Legacy active YAML route blocks | 190 | Runtime observation note only |
| Legacy controller annotations | 49 | Runtime observation note only |
| Legacy route declarations | 239 declarations and 238 unique signatures | Census note only; duplicate declaration remains visible |
| Mono controller routes | 229 | Census note only |
| Mono `ApiResource` classes | 95 | Census note only |
| Mono API operations | 127 | Census note only |
| Committed OpenAPI operations | 126 | Observed stale projection; implementation MUST recompute staleness |
| Legacy custom commands | 6 | Census note only |
| Mono custom commands | 6 | Census note only |
| Repository-owned cron trigger schedule | None observed | Absence observation; no business conclusion and no hard-coded zero |

A changed count is not itself drift. A changed source hash, revision, schema, canonical byte sequence, or explicit reconciliation rule is drift. Every run records observed counts as optional non-normative `observations` records with source references.

## Vocabulary and exact status model

### Identity terms

- **Declaration** is a source-level route, resource, command, write call site, workflow, integration call site, or journey reference.
- **Observation** is a static parse or runtime result. It records what the selected input exposed; it is not an approval.
- **Canonical key** is the normalized semantic key used for exact matching. It never contains an absolute checkout path or a timestamp.
- **Row** is one retained inventory entity. The generator never collapses rows only because two rows look similar.
- **Signature** is the cross-line key used to compare equivalent surface entities. It is separate from the source declaration identity.
- **Coverage reference** links a row to an accepted user-journey step or an explicit accepted non-user-facing disposition.
- **Accepted intent reference** is an immutable human or product-owned reference. The generator validates its shape and hash; it does not create, authenticate, or interpret the business ruling.

### External accepted-intent authority boundary

Production `--diff` and `--write` runs MUST receive exactly one `--intent-register <path>` argument. The path MUST resolve to a tracked regular file in a separate clean Git checkout. That checkout MUST NOT overlap, alias, or be nested within either selected census root or the projection directory. The generator reads the selected blob from the authority checkout's pinned `HEAD` once and retains its exact bytes, commit ID, blob OID, and digest. The authority checkout is never the target checkout and is never scanned as a census root.

Accepted-intent records bind the selected legacy revision reference and the projection-independent mono file-set revision reference, plus exact source hashes. They MUST NOT contain, derive, or self-reference the containing authority commit ID. The generated source manifest records the external authority revision, blob OID, and digest separately. Raw mono Git `HEAD` is execution provenance only and MUST NOT enter deterministic projections, source IDs, revision references, or accepted expected refs. Before a projection exchange, the writer rechecks authority `HEAD`, blob OID, bytes, and digest; any change fails closed as source drift.

The projection directory has exactly the eight committed files named by `COMMITTED_PROJECTIONS`. `accepted-intent.json`, aliases, sidecars, symlinks, directories, and any other entry are not reserved or preserved projection content and block read, diff, and write. Fixture falsifiers MAY use an isolated typed intent snapshot, but fixture bytes are not a production authority mechanism.
- **Dead or unimported source** is a source declaration that the expected loader, compiler, router, command registry, scheduler registry, or adapter graph does not import or resolve. It remains a row.
- **Stale projection** is a committed/generated projection whose normalized source or runtime operation set, source revision, or source hash does not match the selected authority inputs.

### Row states

Every row has exactly one `status`:

| Status | Meaning | Root command treatment |
|---|---|---|
| `covered` | Required source, identity, provenance, and required cross-surface relations exist without a mismatch | Can contribute to `zero_gap` |
| `accounted` | A mismatch or explicit absence has a valid accepted-intent reference | Can contribute to `zero_gap` only for mismatch kinds that permit disposition |
| `missing` | An authority row has no counterpart on the other line | Requires exact accepted intent or produces `gaps_found` |
| `extra` | A current row has no legacy counterpart | Requires exact accepted intent or produces `gaps_found` |
| `changed` | Counterparts exist but a declared method, template, effect, owner, or contract differs | Requires exact accepted intent or produces `gaps_found` |
| `uncovered` | No user-journey coverage reference or accepted non-user-facing reference accounts for a parity-relevant row | Always nonzero |
| `unresolved` | Required source, runtime observation, identity component, import relation, or provenance cannot be resolved | Always nonzero |
| `duplicate` | Two or more retained rows have the same canonical identity in one authority scope | Always nonzero; an intent ref cannot waive it |
| `stale` | A generated projection, including OpenAPI, does not match its selected source or runtime projection | Always nonzero; an intent ref cannot waive it |
| `dead_unimported` | A source declaration is not imported or resolved by its expected loader | Nonzero unless converted to `accounted` by an exact accepted removal/dead-source intent |
| `absent` | A named source family has no declaration at this revision | Every absent row requires an explicit `accepted_absent` disposition and immutable intent ref before it can become `accounted` |
| `not_applicable` | The accepted intent explicitly excludes the row kind from this parity scope | Requires an exact accepted-intent reference |

`accounted` is a derived state. The source mismatch remains visible in `mismatch.kind`; the generator never changes a missing or extra source into a covered source.

### Mismatch kinds and dispositions

`mismatch.kind` is one of `none`, `missing`, `extra`, `changed`, `renamed`, `split`, `merged`, `dead_unimported`, `absent`, `uncovered`, `unresolved`, `duplicate`, `stale`, or `openapi_stale`.

An accepted disposition is one of:

- `accepted_missing`: a named legacy capability is intentionally not present in mono;
- `accepted_extra`: a named mono capability is intentionally new or mono-only;
- `accepted_changed`: a changed contract is intentionally different;
- `accepted_renamed`: one source identity maps to one new identity;
- `accepted_split`: one source identity maps to several explicit identities;
- `accepted_merged`: several source identities map to one explicit identity;
- `accepted_dead_source`: a dead or unimported source is intentionally retired;
- `accepted_absent`: an absent source family is explicitly not owned by this repository;
- `accepted_not_applicable`: an exact row is outside the agreed parity scope;
- `none`: no disposition exists.

`rejected` is a blocking review outcome, not an accepted disposition. A rejected or empty-intent mismatch remains a gap and cannot contribute to `zero_gap`.

The accepted-intent reference MUST name every affected row, exact canonical key, source revision, intent revision, intent digest, and disposition kind. One broad reference cannot cover an unbounded family. Accepted intent cannot suppress `duplicate`, `stale`, `unresolved`, or `uncovered`, and cannot turn an observation into authority.

### Exact report statuses and exit codes

The root command returns exactly one primary status and may list all additional failure statuses. It writes a sanitized deterministic failure report whenever inputs are readable.

| Exit code | Primary status | Trigger |
|---:|---|---|
| `0` | `zero_gap` | All required rows are `covered`, validly `accounted`, or explicitly `not_applicable`; no forbidden state remains |
| `2` | `gaps_found` | Any unaccepted `missing`, `extra`, `changed`, `dead_unimported`, or `absent` row, or any `uncovered` row |
| `3` | `unresolved` | Any row has unresolved identity, import relation, runtime requirement, source edge, or required field |
| `4` | `duplicate` | Any duplicate canonical identity remains in any authority scope |
| `5` | `stale` | Any stale projection remains, including stale committed OpenAPI |
| `6` | `source_unavailable` | A required source file, revision, command output, or intent reference cannot be read |
| `7` | `source_hash_drift` | Selected bytes differ from the pinned source, revision, or input manifest |
| `8` | `schema_invalid` | An artifact or failure report violates its closed JSON Schema or cross-array invariant |
| `9` | `nondeterministic_output` | Two isolated runs produce different deterministic bytes for identical inputs |
| `10` | `runtime_unavailable` | A required local runtime collector cannot run or returns unusable output |
| `11` | `accepted_intent_invalid` | An intent reference is missing, stale, malformed, ambiguous, or does not cover all affected rows |
| `12` | `command_error` | The canonical command cannot parse its arguments or exits before a more specific status is emitted |
| `13` | `falsifier_passed` | Named `--mode fixture_injection --falsifier <ID>` reached its expected result; this is not a parity result |

Failure precedence for production modes is `command_error`, `source_unavailable`, `source_hash_drift`, `schema_invalid`, `nondeterministic_output`, `runtime_unavailable`, `accepted_intent_invalid`, `stale`, `duplicate`, `unresolved`, `gaps_found`, then `projection_written`, then `zero_gap`. Fixture mode returns `falsifier_passed` (exit 13) only when its named falsifier reaches the expected outcome; an unexpected outcome returns the corresponding failure status. `projection_written` is a write-mode completion status, not a failure entry. `failure_statuses` retains every observed failure in byte-sorted order. In particular, a run with any row in `uncovered`, `unresolved`, `stale`, or `duplicate` MUST exit nonzero even when an accepted-intent reference is present.

### Canonical root verification command

The only supported review command is:

```sh
bun run parity:verify -- --root . --legacy-root /srv/share/projects/vektorprogrammet/vektorprogrammet --mode diff
```

It regenerates every required deterministic projection in isolation, schema-validates each artifact, performs all cross-artifact reconciliation, compares the regenerated committed projection set byte-for-byte, writes the zero-gap report and sanitized failure receipt, and exits nonzero for every `uncovered`, `unresolved`, `stale`, `duplicate`, invalid, unavailable, or unaccepted state. `--mode write` is a separate explicit projection-promotion mode; it is not a verification result and returns `projection_written` when successful. Falsifiers use the exact form `bun run parity:verify -- --root . --legacy-root /srv/share/projects/vektorprogrammet/vektorprogrammet --mode fixture_injection --falsifier F3_duplicate_legacy_route`; fixture mode never writes committed projections or claims `zero_gap`.

## Source set, revisions, and provenance

### Required source families

The implementation expands these logical source families from the selected roots. Each expanded path is represented in the source manifest. Paths are relative to a logical root, sorted by UTF-8 byte order, de-duplicated, and hashed before parsing.

| Source family | Legacy read-only paths | Mono paths | Empty result |
|---|---|---|---|
| Route declarations | `app/config/routing.yml`; `app/config/routing_api.yml`; `app/config/routing_dev.yml`; `app/config/routing*.yml`; `src/AppBundle/**/Controller/**/*.php` | `apps/server/config/routes.yaml`; `apps/server/src/App/**/Controller/**/*.php` | No |
| API resource declarations | `src/AppBundle/**/Controller/Api/**/*.php`; `src/AppBundle/**/Entity/**/*.php`; `src/AppBundle/**/Form/**/*.php` | `apps/server/src/App/**/Api/Resource/**/*.php`; `apps/server/src/App/**/Api/State/**/*.php`; `apps/server/src/App/**/Infrastructure/Entity/**/*.php` | No |
| Commands and writes | `src/AppBundle/**/Command/**/*.php`; `src/AppBundle/**/Controller/**/*.php`; `src/AppBundle/**/Service/**/*.php`; `src/AppBundle/**/Entity/**/*.php`; `src/AppBundle/**/Event/**/*.php`; `src/AppBundle/**/EventSubscriber/**/*.php`; `src/AppBundle/**/Repository/**/*.php`; `app/config/services*.yml`; `app/config/config*.yml` | `apps/server/src/App/**/Infrastructure/Command/**/*.php`; `apps/server/src/App/**/Controller/**/*.php`; `apps/server/src/App/**/Infrastructure/Repository/**/*.php`; `apps/server/src/App/**/Infrastructure/Service/**/*.php`; `apps/server/src/App/**/Event/**/*.php`; `apps/server/src/App/**/EventSubscriber/**/*.php`; `apps/server/config/services*.yaml`; `apps/server/config/packages/*.yaml` | No |
| Schedules and background work | `app/config/**/*.yml`; `app/config/**/*.yaml`; `src/AppBundle/**/Command/**/*.php`; `src/AppBundle/**/EventSubscriber/**/*.php`; `.github/workflows/**/*.yml`; `.github/workflows/**/*.yaml` | `.github/workflows/**/*.yml`; `.github/workflows/**/*.yaml`; `infra/**/*.ts`; `infra/**/*.tsx`; `infra/**/*.js`; `infra/**/*.mjs`; `infra/**/*.yml`; `infra/**/*.yaml`; `apps/server/config/**/*.yaml`; `apps/server/src/App/**/Infrastructure/Command/**/*.php`; `apps/server/src/App/**/EventSubscriber/**/*.php` | Yes; an empty result emits an `absent` census observation |
| External integrations | `src/AppBundle/**/Google/**/*.php`; `src/AppBundle/**/Slack/**/*.php`; `src/AppBundle/**/Sms/**/*.php`; `src/AppBundle/**/Mailer/**/*.php`; `src/AppBundle/**/Service/**/*.php`; `src/AppBundle/**/Controller/**/*.php`; `app/config/services*.yml` | `apps/server/src/App/**/Infrastructure/**/*.php`; `apps/server/src/App/**/Support/**/*.php`; `apps/server/src/App/**/Controller/**/*.php`; `packages/**/*.ts`; `packages/**/*.tsx`; `packages/**/*.js`; `.github/workflows/**/*.yml`; `.github/workflows/**/*.yaml`; `infra/**/*.ts`; `infra/**/*.tsx`; `infra/**/*.js`; `infra/**/*.mjs` | No |
| User-journey references | `docs/**/*.md`; `design-specs/**/*.md` | `docs/**/*.md`; `design-specs/**/*.md`; `apps/**/routes/**/*.tsx`; `apps/**/routes/**/*.ts` | No |
| H3 derivation evidence | None | `apps/server/tools/security-h3/0015/generate.ts`; `apps/server/tools/security-h3/0015/generate.test.ts`; `apps/server/tools/security-h3/0015/reason-codes.json`; `apps/server/tools/security-h3/0015/schema.json`; `apps/server/tools/security-h3/0015/fixtures/**/*.json`; `evidence/security-h3/0015/current-route-inventory.json`; `evidence/security-h3/0015/current-resource-inventory.json`; `evidence/security-h3/0015/source-manifest.json`; `evidence/security-h3/0015/route-collector.json`; `evidence/security-h3/0015/decision-packet.json` | No |
| Root census | Full `legacy` census root selected by `--legacy-root` | Full `mono` census root selected by `--root` | No; every regular file is classified exactly once |
| Accepted-intent register | `--intent-register` path in the separate clean authority checkout | Exact immutable intent bytes, authority commit/blob/digest, and target source revision refs | No; never part of either census root or projection directory |
### Explicit census roots and total classification

`legacy` and `mono` are the only census roots. `legacy` binds to the exact path supplied by `--legacy-root`; `mono` binds to the exact checkout supplied by `--root`. The collector enumerates every regular file below each full root, including files that produce no route, API, write, workflow, integration, or journey declaration. It does not narrow a root to the required parity-source globs.

The owned mono derived projection mount `evidence/functional-parity/` is outside the mono census universe even when it is physically nested below `--root`. The collector MUST exclude that mount before path enumeration, source classification, byte hashing, and file-set revision construction. No projection entry, including an invalid or unexpected entry, is a mono census record or source reference; read, diff, and write stages independently enforce the exact-eight closure.

| Census root | Authority | Physical binding | Complete-scan rule |
|---|---|---|---|
| `legacy` | `legacy` | `--legacy-root` and the pinned legacy revision | Enumerate every regular file below the root; legacy source is read-only |
| `mono` | `mono` | `--root` and the selected mono revision | Enumerate every regular file below the root except the pre-enumeration derived projection mount; the 0023 baseline is the first allowed checkpoint |

The required source families above are parity selectors and may overlap by authority role. They do not define the root census. For each bound root, the collector first applies the ordered residual ignore register, then evaluates the single `**/*` census family and only then applies first-party source-family selectors. Dependency and generated-output residuals therefore remove `packages/sdk/dist/**` from external-integration matching.

For one root, let `M_i` be the set of paths matched by the literal predicate in rule order `i`. The effective predicate is `E_i = M_i \ (M_0 ∪ ... ∪ M_(i-1))`. The collector assigns the first matching effective rule and records exactly one `ignore_rule_id`; raw predicate overlap is expected and is resolved by set difference, not rejected. Rules are ordered by ascending `precedence`, then literal `pattern`, then `ignore_rule_id`; `precedence` is scoped to `root_ref`. A duplicate classification after path normalization is `schema_invalid`; raw overlap is never that failure.

| Precedence | Rule kind | Root scope | Literal predicate | Residual meaning | Rationale |
|---:|---|---|---|---|---|
| 10 | `repository_metadata` | `legacy`, `mono` | `**/.git/**` | Repository metadata wins over every later class | Git administrative bytes are not application declarations. |
| 20 | `dependency_cache` | `legacy`, `mono` | `**/node_modules/**` | Nested node-module trees win over later classes | Nested JavaScript dependency bytes are not first-party declarations. |
| 21 | `dependency_cache` | `legacy`, `mono` | `**/vendor/**` | Nested vendor trees win after node-module subtraction | Nested third-party dependency bytes are not first-party declarations. |
| 30 | `generated_output` | `legacy`, `mono` | `**/dist/**` | Distribution output after metadata/dependency subtraction | Distribution output is derived and is not a declaration authority. |
| 31 | `generated_output` | `legacy`, `mono` | `**/build/**` | Build output after metadata/dependency/dist subtraction | Build output is derived and is not a declaration authority. |
| 40 | `build_cache` | `legacy`, `mono` | `**/.turbo/**` | Turbo cache after earlier exclusions | Turbo cache bytes are generated build state. |
| 41 | `build_cache` | `legacy`, `mono` | `**/.cache/**` | Tool cache after earlier exclusions | Tool cache bytes are generated build state. |
| 50 | `runtime_cache` | `legacy` | `app/cache/**` | Legacy application cache residual | Legacy application cache is generated execution state. |
| 51 | `runtime_cache` | `legacy` | `cache/**` | Legacy root cache residual | Legacy root cache is generated execution state. |
| 52 | `runtime_cache` | `legacy` | `var/cache/**` | Legacy var cache residual | Legacy var cache is generated execution state. |
| 53 | `runtime_cache` | `legacy` | `var/data/**` | Legacy var data residual | Legacy var data is generated runtime state. |
| 53 | `runtime_cache` | `mono` | `apps/server/var/**` | Mono server runtime residual | Server runtime state is generated execution data. |
| 60 | `runtime_log` | `legacy` | `app/logs/**` | Legacy application log residual | Legacy application logs are execution evidence. |
| 61 | `runtime_log` | `legacy` | `logs/**` | Legacy root log residual | Legacy root logs are execution evidence. |
| 62 | `runtime_log` | `legacy` | `var/logs/**` | Legacy var log residual | Legacy var logs are execution evidence. |
| 63 | `runtime_log` | `legacy` | `**/npm-debug.log` | Nested legacy npm debug-log residual | Nested npm debug logs are execution evidence. |
| 70 | `test_support` | `legacy`, `mono` | `**/coverage/**` | Coverage output after earlier exclusions | Coverage output is test evidence, not parity authority. |
| 80 | `binary_tool` | `legacy` | `composer.phar` | Bundled Composer tool after earlier exclusions | Bundled Composer is an executable tool, not a source declaration. |

Each backtick-delimited predicate is a separate register rule. `**` is recursive, can match zero path segments, and is evaluated with `include_hidden: true`; no brace expansion, alias, extension filter, parser filter, or root-anchored dependency predicate is allowed. A path outside all ignore residuals is evaluated by the one `**/*` census family. A readable file with no parity declaration still receives a matched census row and a whole-file source record.

The only ignored classes are the ordered residuals above. The implementation MUST report `unclassified_count: 0` for both pinned roots after this accounting; this is a current non-normative observation, not a schema cardinality. Any nonzero count or an unclassified path fails closed.

### Root census classification and ignore rules

The root census classifies the full root set, not the union of required source-family matches. Before opening a regular file, the generator normalizes its relative path, excludes the mono projection mount, evaluates the closed ordered ignore register, and only then performs path safety and byte reads. It emits exactly one `matched`, `ignored`, or `unclassified` record. A file that matches no census family is retained as `unclassified` with `classification_status: "unclassified"`, reason `UNCLASSIFIED_SOURCE`, and status `unresolved`; it is nonzero. A census match does not imply a declaration, and a parity parser may still emit zero rows.

The ordered ignore register is part of `source-manifest.json`, is hashed into `source_set_sha256`, and is closed: an implementation cannot add a local pattern or narrow a census root. Each rule has an immutable ID, authority scope, logical root, `precedence`, literal `pattern`, `selection: "ordered_set_difference"`, rule kind, and rationale. The table's `Rationale` column is normative: every root-scoped rule emits the exact byte-identical string shown for its `(root_ref, precedence, pattern)` tuple. Ignore rules cannot cover first-party source declarations, H3 derivation inputs, generated projections selected by a source family, or accepted-intent records before residual classification.

`ignore_rule_id` is lowercase SHA-256 over the compact canonical object `{authority_line, root_ref, precedence, pattern, selection, rule_kind, rationale}` with the `ignore-` prefix. The implementation sorts rules by `(root_ref, precedence, pattern, ignore_rule_id)` and assigns one effective rule per normalized path. It never reports raw overlap as a failure.

`source-manifest.json.root_census` contains one record for every regular file under each explicit census root. Each record includes the relative path, byte length and digest when readable, availability, classification, source reference IDs, and exactly one effective `ignore_rule_id` only for `ignored`. `matched` and `unclassified` records have a non-empty `source_ref_ids` array and a null `ignore_rule_id`; `ignored` records have an empty `source_ref_ids` array and one effective rule ID. An ignored path is classified without opening its bytes: its `byte_length` and `sha256` are both `null`, and it has no source reference even when the on-disk bytes are invalid or contain unsafe values. An unreadable non-ignored file is `unclassified` with `availability: "unavailable"`, a null digest, and a blocking `source_unavailable` or `unresolved` failure. No file may be dropped because its parser does not recognize a declaration.

### Source path and textual byte safety

Classification is a pre-read boundary. The owned mono projection mount `evidence/functional-parity/` is excluded before enumeration and cannot produce a census record, source ID, digest, or file-set revision input. Every effective closed ignore-rule match is classified `ignored` before a file is opened. Ignored bytes never enter `byte_length`, `sha256`, source references, parser inputs, runtime observations, or deterministic artifacts. The record retains only the normalized path, the effective rule ID, and null byte/digest fields.

Non-ignored credential, secret, private-key, raw-payload, backup, dump, or database path classes fail closed before bytes are read. This path register is semantic, not a blanket extension denylist: `.env` and `.sql` are legitimate source classes and are admitted to textual validation. A legacy nested `**/npm-debug.log` path is an explicit `runtime_log` residual when no earlier normative residual applies; tracked log/debug artifacts are therefore never hashed.

Matched textual config/source files use fatal UTF-8 decoding before hashing. Dotenv assignments reject concrete credential or personal-data values, but allow empty values, framework placeholders, and explicit test-only sentinels. SQL source accepts DDL and executable migration code, but rejects literal data inserts, concrete credential assignments, and PII. The validator does not entropy-scan identifiers or source-code names. Unsafe content fails before a digest, source ID, or deterministic artifact claim is created, and all failure reasons are sanitized.

```json
{
  "ignore_rules": [
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 10,
      "pattern": "**/.git/**",
      "selection": "ordered_set_difference",
      "rule_kind": "repository_metadata",
      "rationale": "Git administrative bytes are not application declarations."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 20,
      "pattern": "**/node_modules/**",
      "selection": "ordered_set_difference",
      "rule_kind": "dependency_cache",
      "rationale": "Nested JavaScript dependency bytes are not first-party declarations."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 21,
      "pattern": "**/vendor/**",
      "selection": "ordered_set_difference",
      "rule_kind": "dependency_cache",
      "rationale": "Nested third-party dependency bytes are not first-party declarations."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 30,
      "pattern": "**/dist/**",
      "selection": "ordered_set_difference",
      "rule_kind": "generated_output",
      "rationale": "Distribution output is derived and is not a declaration authority."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 31,
      "pattern": "**/build/**",
      "selection": "ordered_set_difference",
      "rule_kind": "generated_output",
      "rationale": "Build output is derived and is not a declaration authority."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 40,
      "pattern": "**/.turbo/**",
      "selection": "ordered_set_difference",
      "rule_kind": "build_cache",
      "rationale": "Turbo cache bytes are generated build state."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 41,
      "pattern": "**/.cache/**",
      "selection": "ordered_set_difference",
      "rule_kind": "build_cache",
      "rationale": "Tool cache bytes are generated build state."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 50,
      "pattern": "app/cache/**",
      "selection": "ordered_set_difference",
      "rule_kind": "runtime_cache",
      "rationale": "Legacy application cache is generated execution state."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 51,
      "pattern": "cache/**",
      "selection": "ordered_set_difference",
      "rule_kind": "runtime_cache",
      "rationale": "Legacy root cache is generated execution state."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 52,
      "pattern": "var/cache/**",
      "selection": "ordered_set_difference",
      "rule_kind": "runtime_cache",
      "rationale": "Legacy var cache is generated execution state."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 53,
      "pattern": "var/data/**",
      "selection": "ordered_set_difference",
      "rule_kind": "runtime_cache",
      "rationale": "Legacy var data is generated runtime state."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 60,
      "pattern": "app/logs/**",
      "selection": "ordered_set_difference",
      "rule_kind": "runtime_log",
      "rationale": "Legacy application logs are execution evidence."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 61,
      "pattern": "logs/**",
      "selection": "ordered_set_difference",
      "rule_kind": "runtime_log",
      "rationale": "Legacy root logs are execution evidence."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 62,
      "pattern": "var/logs/**",
      "selection": "ordered_set_difference",
      "rule_kind": "runtime_log",
      "rationale": "Legacy var logs are execution evidence."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 63,
      "pattern": "**/npm-debug.log",
      "selection": "ordered_set_difference",
      "rule_kind": "runtime_log",
      "rationale": "Nested npm debug logs are execution evidence."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 70,
      "pattern": "**/coverage/**",
      "selection": "ordered_set_difference",
      "rule_kind": "test_support",
      "rationale": "Coverage output is test evidence, not parity authority."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 80,
      "pattern": "composer.phar",
      "selection": "ordered_set_difference",
      "rule_kind": "binary_tool",
      "rationale": "Bundled Composer is an executable tool, not a source declaration."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "mono",
      "root_ref": "mono",
      "precedence": 10,
      "pattern": "**/.git/**",
      "selection": "ordered_set_difference",
      "rule_kind": "repository_metadata",
      "rationale": "Git administrative bytes are not application declarations."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "mono",
      "root_ref": "mono",
      "precedence": 20,
      "pattern": "**/node_modules/**",
      "selection": "ordered_set_difference",
      "rule_kind": "dependency_cache",
      "rationale": "Nested JavaScript dependency bytes are not first-party declarations."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "mono",
      "root_ref": "mono",
      "precedence": 21,
      "pattern": "**/vendor/**",
      "selection": "ordered_set_difference",
      "rule_kind": "dependency_cache",
      "rationale": "Nested third-party dependency bytes are not first-party declarations."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "mono",
      "root_ref": "mono",
      "precedence": 30,
      "pattern": "**/dist/**",
      "selection": "ordered_set_difference",
      "rule_kind": "generated_output",
      "rationale": "Distribution output is derived and is not a declaration authority."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "mono",
      "root_ref": "mono",
      "precedence": 31,
      "pattern": "**/build/**",
      "selection": "ordered_set_difference",
      "rule_kind": "generated_output",
      "rationale": "Build output is derived and is not a declaration authority."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "mono",
      "root_ref": "mono",
      "precedence": 40,
      "pattern": "**/.turbo/**",
      "selection": "ordered_set_difference",
      "rule_kind": "build_cache",
      "rationale": "Turbo cache bytes are generated build state."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "mono",
      "root_ref": "mono",
      "precedence": 41,
      "pattern": "**/.cache/**",
      "selection": "ordered_set_difference",
      "rule_kind": "build_cache",
      "rationale": "Tool cache bytes are generated build state."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "mono",
      "root_ref": "mono",
      "precedence": 53,
      "pattern": "apps/server/var/**",
      "selection": "ordered_set_difference",
      "rule_kind": "runtime_cache",
      "rationale": "Server runtime state is generated execution data."
    },
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "mono",
      "root_ref": "mono",
      "precedence": 70,
      "pattern": "**/coverage/**",
      "selection": "ordered_set_difference",
      "rule_kind": "test_support",
      "rationale": "Coverage output is test evidence, not parity authority."
    }
  ]
}
```
The JSON shape is illustrative. A generated register contains one real rule ID per root-scoped predicate, a root-scoped precedence, `selection: "ordered_set_difference"`, and the exact residual semantics defined above. Raw predicate overlap is not a failure; only more than one normalized classification record for the same root and path is invalid.

### Source manifest records

`source-manifest.json` is a deterministic JSON object with this shape:

```json
{
  "schema_version": "functional-parity-source-manifest/v1",
  "manifest_id": "source-manifest-<sha256-of-logical-source-set>",
  "source_set": "legacy-and-mono-functional-parity",
  "census_roots": [
    {
      "root_ref": "legacy",
      "authority_line": "legacy",
      "repository_ref": "legacy",
      "revision_ref_id": "rev-legacy-<full-revision>",
      "root_kind": "repository",
      "scan_mode": "all_regular_files"
    },
    {
      "root_ref": "mono",
      "authority_line": "mono",
      "repository_ref": "mono",
      "revision_ref_id": "rev-mono-<full-revision>",
      "root_kind": "repository",
      "scan_mode": "all_regular_files"
    }
  ],
  "revisions": [
    {
      "revision_ref_id": "rev-legacy-<full-revision>",
      "repository_ref": "legacy",
      "revision_kind": "git_commit",
      "revision": "<40 lowercase hexadecimal characters>",
      "immutable": true
    }
  ],
  "runtime_observations": [
    {
      "runtime_observation_ref_id": "runtime-<sha256-of-command-register>",
      "revision_ref_id": "rev-mono-<full-revision>",
      "collector_kind": "route_collector",
      "command": "php bin/console debug:router --format=json --env=test",
      "argument_digest": "sha256:<64 lowercase hex characters>",
      "stdout_sha256": "sha256:<64 lowercase hex characters>",
      "stderr_sha256": "sha256:<64 lowercase hex characters>",
      "exit_code": 0,
      "result_sha256": "sha256:<64 lowercase hex characters>",
      "availability": "available"
    }
  ],
  "sources": [
    {
      "source_id": "src-<sha256-of-logical-reference>",
      "authority_line": "legacy",
      "authority_role": "legacy_route_authority",
      "repository_ref": "legacy",
      "revision_ref_id": "rev-legacy-<full-revision>",
      "path": "app/config/routing.yml",
      "line_start": 1,
      "line_end": 1200,
      "symbol": null,
      "byte_length": 123,
      "sha256": "sha256:<64 lowercase hex characters>",
      "capture_mode": "static",
      "availability": "available",
      "classification_status": "classified"
    }
  ],
  "root_census": [
    {
      "census_id": "census-<sha256-of-census-record>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "path": "vendor/example.php",
      "byte_length": null,
      "sha256": null,
      "availability": "available",
      "classification": "ignored",
      "source_ref_ids": [],
      "ignore_rule_id": "ignore-<sha256-of-rule>"
    }
  ],
  "ignore_rules": [
    {
      "ignore_rule_id": "ignore-<sha256-of-rule>",
      "authority_line": "legacy",
      "root_ref": "legacy",
      "precedence": 21,
      "pattern": "**/vendor/**",
      "selection": "ordered_set_difference",
      "rule_kind": "dependency_cache",
      "rationale": "Nested third-party dependency bytes are not first-party declarations."
    }
  ],
  "source_set_sha256": "sha256:<64 lowercase hex characters>"
}
```

The example uses shape markers for readability. A generated artifact contains a real full revision, byte length, digest, explicit `census_roots`, closed root-census register, and closed ordered residual ignore-rule register. `census_roots`, `revisions`, `runtime_observations`, `root_census`, and `ignore_rules` are deterministic registers, not execution timestamps. Each census root names one full repository root and uses `scan_mode: "all_regular_files"`. Each revision record has `revision_ref_id`, `repository_ref`, `revision_kind`, `revision`, and `immutable: true`. Each runtime observation record has `runtime_observation_ref_id`, `revision_ref_id`, `collector_kind`, `command`, `argument_digest`, `stdout_sha256`, `stderr_sha256`, `exit_code`, `result_sha256`, and `availability`. Each root-census record has `census_id`, `authority_line`, `root_ref`, `path`, `byte_length`, `sha256`, `availability`, `classification`, `source_ref_ids`, and `ignore_rule_id`. Each ignore rule has `ignore_rule_id`, `authority_line`, `root_ref`, `precedence`, `pattern`, `selection`, `rule_kind`, and `rationale`. All register objects are closed and sorted by their root-scoped order.

The legacy Git revision MAY remain a `git_commit` provenance revision. The mono deterministic revision MUST be `file_set_digest`: SHA-256 over compact canonical JSON for the sorted authoritative tracked Git blob set `{path, sha256}` after pre-enumeration exclusion of `evidence/functional-parity/`. Projection bytes, projection paths, and raw Git `HEAD` MUST NOT enter that digest. A non-Git source MUST use an immutable archive or file-set digest. Runtime command-output records remain deterministic because they contain hashes and exit status, not time or host data; command output bytes are evidence, not source authority.


Source references use exact line numbers from the selected bytes when a parser can provide them. A parser that cannot provide an exact line or symbol emits null and a reason code; it does not invent a line. Every row has at least one source reference and one revision reference, or it is `unresolved`.

### Runtime and static observation classes

Rows retain all applicable `observation_kinds`:

- `static_source`: parser found a declaration in source bytes;
- `runtime_resolution`: a local framework/registry collector resolved an operation;
- `runtime_evidence`: a separately supplied local run observed a named operation or workflow;
- `generated_projection`: a generated file such as OpenAPI exposed a projection;
- `accepted_intent`: an immutable intent or journey reference supplied a disposition or coverage edge;
- `derived_h3`: a row was derived from an H3 artifact, with source edges preserved.

A static row missing from a required runtime resolution is `dead_unimported` or `unresolved`, depending on whether the collector completed. A runtime row with no static source edge is `extra` plus reason `RUNTIME_ONLY_SOURCE`; it is never silently adopted as source authority. A static/runtime field disagreement retains both observations and is `unresolved` or `changed`; the generator does not select one layer by preference.

## Identity and normalization

### Normalization rules

The generator applies these rules before it builds a canonical key:

1. Decode source bytes as UTF-8. Invalid UTF-8 is `source_unavailable` or `unresolved`; replacement characters are forbidden.
2. Normalize human-readable identifiers and route templates to Unicode NFC. Preserve original source text only in a non-deterministic execution-evidence pointer, never in a deterministic row when it contains identity data.
3. Trim ASCII whitespace around scalar values. Preserve internal whitespace unless the field rule below defines a separator.
4. Uppercase HTTP methods and sort unique method arrays by byte order. An empty method set remains empty and makes the row `unresolved`.
5. Normalize a route path to one leading `/`, preserve framework variables and regex constraints exactly, and do not URL-decode, collapse meaningful duplicate slashes, remove trailing slashes, or infer a variable name. A parser that cannot distinguish a normalized path from a source path emits `unresolved`.
6. Normalize route names, command names, class names, symbol names, provider keys, and operation identifiers with NFC and exact case. Case is not folded because source systems can distinguish it.
7. Normalize a schedule expression as the exact source expression plus a parsed trigger kind. Never convert a missing schedule into a default cron expression.
8. Normalize external endpoints to scheme, host, port, path template, and direction. Remove query values and credentials. A secret, token, personal address, or raw payload in a source field is a `source_unavailable` failure with reason `UNSAFE_SOURCE`; the value is not emitted.
9. Normalize arrays by de-duplicating exact normalized values and sorting by byte order. Sort object keys recursively before serialization.
10. Use decimal JSON numbers only for byte lengths, line numbers, and counts. Do not emit `NaN`, infinities, timestamps, random IDs, hostnames, absolute paths, locale-dependent values, or environment variables in deterministic artifacts.

The normalizer MUST preserve a `raw_source_digest` through a source reference, not by copying raw source text into a row. It MUST NOT infer a route, operation, effect, schedule, integration, or journey from a count.

### Identity layers

Each row has both a declaration identity and a comparison signature.

| Identity | Formula | Purpose |
|---|---|---|
| `census_id` | Hash of `{authority_line, root_ref, path, byte_length, sha256, availability, classification, source_ref_ids, ignore_rule_id}` | Retains one deterministic classification outcome for each regular file |
| `declaration_id` | Hash of `{authority_line, repository_ref, logical_path, declaration_kind, ordinal_within_file}` | Retains every source declaration across source revisions when its logical path and ordinal remain stable |
| `canonical_key` | Canonical JSON of the kind-specific semantic identity | Exact matching within and across lines |
| `signature` | Canonical JSON of the cross-line comparison identity | Reconciliation without source-path substitution |
| `duplicate_group_id` | Hash of `{authority scope, inventory kind, canonical_key}` | Groups exact duplicate identities; null only when no duplicate exists |
| `row_id` | Hash of `{inventory_kind, declaration_id, canonical_key}` | Stable when the declaration identity and semantic key remain stable |

The hash encoding for these IDs is lowercase SHA-256 over compact canonical UTF-8 JSON, prefixed with the ID label. A row ID is not an approval ID and is not an identity-bearing user identifier.

### Route identity

A legacy or mono route signature is the exact tuple:

```text
("http_route", method, path_template, route_name_or_null)
```

`route_name` remains a separate component. A path/method match with a different route name is `changed`, not automatically equal. A route-name-only source declaration has a null path and is `unresolved` unless the runtime source resolves the path. A route with multiple methods has one row per method after normalization, with a shared `declaration_id` and a distinct canonical key per method. A declaration with the same signature more than once is retained in `duplicate` rows.

Legacy YAML route blocks and controller annotations are separate declarations even when their signatures match. The duplicate group exposes the 190/49/239/238 planning observation without treating it as an acceptance target.

### API operation identity

An API operation signature is:

```text
("api_operation", resource_class_ref, operation_name, method, uri_template, operation_id_or_null)
```

`resource_key`, provider, processor, and schema refs remain separate fields. The generator MUST NOT infer a resource key from a URI, route name, controller name, or method. A missing or conflicting resource key is `unresolved` when the selected API source requires it.

### Command and write identity

A command/write signature is:

```text
("command_write", owner_ref, entry_kind, command_name_or_null, symbol_ref, effect_class, target_ref)
```

A command class, controller write, repository write, event handler, and external call site are separate rows. A method string does not prove read-only behavior. A source-level write whose effect cannot be traced is `unresolved` with `effect_class: "unknown"`.

### Schedule and background identity

A schedule/background signature is:

```text
("schedule_background", trigger_kind, trigger_identity, owner_ref, handler_ref, schedule_expression_or_null)
```

A workflow dispatch, queue consumer, startup hook, event subscriber, manual command, and cron expression are distinct trigger kinds. A repository with no owned cron trigger produces an explicit `absent` family observation; it does not prove that a provider or external scheduler has no schedule.

### External integration identity

An external integration signature is:

```text
("external_integration", provider_ref, direction, protocol, endpoint_ref_or_null, call_site_ref)
```

Credential values, tokens, email addresses, user names, and raw payloads never enter a canonical key. An unresolved provider or endpoint remains a row with `provider_ref: null` and status `unresolved`.

### User-journey identity

A journey signature is:

```text
("user_journey", accepted_intent_ref_id, journey_key, ordered_step_ids)
```

The journey key is supplied by accepted intent. The generator does not invent a product journey from route filenames. Each step names exact row IDs or canonical signatures. A row with no journey step or accepted non-user-facing disposition is `uncovered`.

## Inventory artifacts

The implementation writes these deterministic artifacts under the parity evidence directory. The exact directory is part of the implementation capsule and is not a source authority.

```text
source-manifest.json
legacy-routes.json
mono-routes.json
api-operations.json
command-write-paths.json
scheduled-background-workflows.json
external-integrations.json
user-journey-coverage.json
openapi-reconciliation.json
zero-gap-report.json
```

The committed projection set contains `source-manifest.json` and the seven inventory files. The regenerated OpenAPI operation reconciliation has one exact artifact home: `openapi-reconciliation.json`. The zero-gap report contains only `openapi_reconciliation_ref`, which MUST resolve to that artifact; it does not duplicate reconciliation fields or operation rows. `packages/sdk/openapi.json` is the committed input projection compared by that reconciliation. `--write` updates only the source manifest and seven inventory files. `--diff` compares that set and regenerates the reconciliation and report.

Every inventory uses the following envelope:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "schema_version": "functional-parity-inventory/v1",
  "inventory_kind": "legacy_route",
  "authority_line": "legacy",
  "source_manifest_sha256": "sha256:<64 lowercase hex characters>",
  "revision_ref_ids": ["rev-legacy-<full-revision>"],
  "observation_kinds": ["static_source"],
  "rows": [],
  "links": [],
  "observations": [],
  "derivation_edges": []
}
```

The inventory and reconciliation files contain no `artifact_sha256` field. Their exact bytes are hashed as written; the digest appears only in the report's `inventory_artifact_sha256` map and in timestamped execution evidence. A deterministic artifact MUST NOT self-hash a field that changes its own bytes. The generated JSON contains no `generated_at` field.

### Common row contract

Every row in every inventory has these fields:

| Field | Type and rule |
|---|---|
| `row_id` | Non-empty deterministic `row-...` string; unique within the complete run |
| `declaration_id` | Non-empty deterministic source declaration ID |
| `inventory_kind` | Closed category enum matching the file |
| `authority_line` | `legacy`, `mono`, or `cross_line` |
| `canonical_key` | Canonical JSON string or deterministic digest of the kind-specific identity |
| `signature` | Canonical cross-line signature; no source path or timestamp |
| `status` | Exact row-state enum above |
| `observation_kinds` | Unique sorted observation classes |
| `source_ref_ids` | One or more source manifest IDs |
| `revision_ref_ids` | One or more immutable revision IDs |
| `runtime_observation_ref_ids` | Zero or more command-output evidence IDs |
| `coverage_ref_ids` | Zero or more accepted journey or explicit non-user-facing refs |
| `accepted_intent_ref_ids` | Zero or more exact accepted-intent refs |
| `duplicate_group_id` | Deterministic group ID or null |
| `mismatch` | Closed mismatch object; `kind: "none"` for covered rows |
| `details` | Closed kind-specific payload selected by `inventory_kind` |
| `reason_codes` | Unique sorted closed reason-code enum |
| `related_row_ids` | Unique sorted row IDs for exact reconciliation edges |

No row may use an unlisted field. Unknown fields are a schema failure. Free-form source text, raw endpoint responses, secrets, credentials, identities, and payloads are forbidden.

### Legacy route rows

`legacy-routes.json` contains one row for every active YAML route block and every controller annotation discovered by the required source families. Each row includes:

```json
{
  "details": {
    "declaration_kind": "yaml_route_block",
    "route_name": "name-or-null",
    "path_template": "/path/{variable}",
    "method": "GET",
    "methods_declared": ["GET"],
    "controller_ref": "App\\Controller\\ExampleController::action",
    "import_ref": null,
    "deprecated": false
  }
}
```

`declaration_kind` is one of `yaml_route_block`, `controller_annotation`, `imported_route`, `vendor_route`, or `unknown`. The source line, controller symbol, route name, path, and method are independent fields. A parser cannot use a route name as a path substitute.

### Mono route rows

`mono-routes.json` contains static mono controller/API route declarations and resolved mono route observations. Each row includes:

```json
{
  "details": {
    "declaration_kind": "controller_attribute",
    "route_origin": "controller",
    "route_name": "name-or-null",
    "path_template": "/path/{variable}",
    "method": "GET",
    "owner_ref": "App\\Controller\\ExampleController::action",
    "runtime_resolved": true,
    "imported_from_ref": null
  }
}
```

`route_origin` is `controller`, `api_platform`, `imported`, or `vendor`. Static and runtime rows reconcile through exact route signatures. A runtime route with no source edge remains visible as `extra` or `unresolved`.

### API operation rows

`api-operations.json` contains API Platform resource and operation declarations from `Api/Resource`, `Infrastructure/Entity`, provider/processor metadata, local runtime metadata, and the generated OpenAPI projection. Each row includes:

```json
{
  "details": {
    "resource_class_ref": "App\\Survey\\Api\\Resource\\Survey",
    "resource_key": "resource-key-or-null",
    "operation_name": "GetCollection",
    "method": "GET",
    "uri_template": "/api/surveys",
    "operation_id": "api_surveys_get_collection",
    "provider_ref": "App\\Survey\\Api\\State\\SurveyProvider",
    "processor_ref": null,
    "schema_ref": "component-or-null",
    "openapi_projection_ref": "openapi-row-or-null"
  }
}
```

`resource_key` is observed only when named by the API metadata. The generator MUST NOT derive it from any other field. An operation with an unresolvable provider, processor, or resource class remains in the inventory and receives `unresolved` or `unknown` reason codes.

### Command and write rows

`command-write-paths.json` contains custom command classes, command registrations, controller/form writes, repository writes, event handlers, message consumers, state processors, and external write call sites. Each row includes:

```json
{
  "details": {
    "entry_kind": "custom_command",
    "owner_ref": "App\\Admission\\Infrastructure\\Command\\SendAdmissionNotificationsCommand",
    "command_name": "app:send_admission_notifications",
    "symbol_ref": "__invoke__-or-method",
    "effect_classes": ["outbound"],
    "target_refs": ["mail-provider-or-domain-service"],
    "write_contract_ref": "contract-or-null"
  }
}
```

`entry_kind` is one of `custom_command`, `controller_write`, `repository_write`, `api_processor`, `event_handler`, `message_consumer`, `integration_write`, or `unknown`. `effect_classes` is a sorted non-empty set from `read_only`, `durable_write`, `identity_or_authority`, `outbound`, `filesystem`, `scheduler`, and `unknown`. `unknown` is required when the call graph is incomplete. The method `GET`, a class name, or a command name cannot remove `unknown`.

### Scheduled and background rows

`scheduled-background-workflows.json` contains source-declared and runtime-observed workflows. Each row includes:

```json
{
  "details": {
    "trigger_kind": "queue",
    "trigger_identity": "queue-name-or-trigger-id",
    "schedule_expression": null,
    "owner_ref": "owner-or-null",
    "handler_ref": "handler-or-null",
    "enabled": true,
    "repository_owned": true,
    "runtime_registered": true
  }
}
```

`trigger_kind` is one of `cron`, `queue`, `event`, `manual`, `workflow_dispatch`, `startup`, `webhook`, or `unknown`. A schedule expression is null when the trigger is not a schedule. Missing repository-owned cron declarations are represented by a deterministic source-family observation with `status: "absent"`; the inventory does not claim that an external scheduler has no trigger. Every absence row requires an `accepted_absent` disposition and immutable intent ref before it can become `accounted`.

### External integration rows

`external-integrations.json` contains static call sites, inbound handlers, adapter declarations, credential-slot references, and permitted local runtime observations. Each row includes:

```json
{
  "details": {
    "provider_ref": "github-api-or-null",
    "direction": "outbound",
    "protocol": "https",
    "endpoint_ref": "https://api.github.com/meta-or-null",
    "credential_slot_ref": "credential-slot:github-or-null",
    "call_site_ref": "App\\Controller\\GitHubController::method",
    "contract_ref": "accepted-contract-or-null",
    "effect_classes": ["outbound"]
  }
}
```

`direction` is `inbound`, `outbound`, or `bidirectional`. Endpoint query values, authorization headers, tokens, payloads, and personal data are not emitted. Unknown provider or protocol values remain `unresolved` rather than being classified as local.

### User-journey coverage rows

`user-journey-coverage.json` contains only immutable accepted journey references and exact row links. Each row includes:

```json
{
  "details": {
    "journey_ref_id": "intent:<revision>:<path>#<row>",
    "journey_key": "journey-key",
    "intent_ref_id": "intent:<revision>:<path>#<row>",
    "steps": [
      {
        "step_id": "step-01",
        "surface": "mono_route",
        "row_ids": ["row-..."],
        "canonical_signatures": [],
        "expected_contract_ref": "contract-ref-or-null",
        "runtime_evidence_ref_ids": []
      }
    ],
    "coverage_scope": "user_visible"
  }
}
```

`coverage_scope` is `user_visible`, `operator_visible`, `background`, or `accepted_non_user_facing`. A journey step with no exact row ID or canonical signature is `unresolved`. A parity-relevant route, API operation, write, schedule, or integration that is not linked from a journey or an accepted non-user-facing scope is `uncovered`.

## Reconciliation rules

### Cross-line matching

The generator compares typed signatures only:

1. Legacy and mono HTTP routes match only on exact `(method, path_template, route_name_or_null)` after normalization. A method mismatch is `changed`; a path-only or route-name-only fallback is forbidden.
2. API operations match only on exact API operation signature. A resource key never falls back to a URI, route name, controller, or method.
3. Commands and writes match only when the entry kind, owner/contract identity, command name or symbol, effect class, and target are all compatible. A same-named command with a different target is `changed`.
4. Schedules match on typed trigger identity, owner, handler, and exact schedule expression. A manual workflow is not a cron workflow.
5. Integrations match on provider, direction, protocol, endpoint template, and call site. A host-only match is not enough when the endpoint or direction differs.
6. User journeys match only through accepted intent refs and exact row/canonical-key links. A page filename does not create a journey.
7. Each counterpart relation is explicit in `links` with `relation_kind: "matches"`, `"derives"`, `"imports"`, `"covers"`, `"observes"`, or `"reconciles"`. A generic related-to edge is forbidden.

Every authority row receives a reconciliation result. The generator retains both sides for a missing or extra row. It never deletes a legacy row because a mono row looks similar and never deletes a mono row because OpenAPI omitted it.

### Duplicate detection

Duplicate detection runs before reconciliation and after normalization. The exact tuple is `(authority_line, inventory_kind, canonical_key)`. Any repeated tuple produces a `duplicate_group_id`, `status: "duplicate"`, `reason_codes` including `DUPLICATE_CANONICAL_IDENTITY`, and a report failure. Duplicate rows remain separate and retain separate source refs. An accepted intent may explain a planned fix, but it cannot produce `zero_gap` while the duplicate exists.

The declaration count and unique-signature count are separate observations. The 239/238 legacy planning observation is one example of why the command must not collapse duplicate declarations.

### Dead and unimported source detection

The generator builds an import graph for every required source family:

```text
source declaration
  -> parser record
  -> loader/config/import edge
  -> runtime or generated projection
  -> cross-surface relation
```

A source declaration missing the parser edge is `unresolved` with `SOURCE_PARSE_ERROR`. A parsed declaration missing the loader/import edge is `dead_unimported`. A loader edge pointing to an unreadable source is `source_unavailable`. A runtime row with no source edge is `extra` and `RUNTIME_ONLY_SOURCE`. None of these states is hidden by a count or by a copied inventory.

### Static/runtime mismatch

The report carries separate static and runtime digests. If static and runtime disagree on a required identity field, the rows remain linked by `reconciles` and receive `STATIC_RUNTIME_MISMATCH`. The status is `changed` only when both sides resolve and differ; it is `unresolved` when either side cannot be resolved. The generator does not promote runtime truth over source truth or source truth over runtime observation.

### Stale OpenAPI detection

`openapi-reconciliation.json` compares `packages/sdk/openapi.json` with a freshly generated local OpenAPI projection for the same mono revision. The projection is normalized to `(method, path_template, operation_id_or_null, response/schema component digest)`. The comparison records:

- committed artifact source ref, byte digest, and revision;
- regenerated projection source ref, command-output digest, and mono revision;
- operations only in the committed projection;
- operations only in the regenerated projection;
- operations with changed method, path, operation ID, response, or schema digest;
- source-manifest and operation-set digests.

Any difference, missing committed artifact, stale source revision, or inability to regenerate sets `status: "stale"`, `mismatch.kind: "openapi_stale"`, and reason `STALE_OPENAPI_PROJECTION`. A stale OpenAPI projection cannot be waived by accepted intent because it is a deterministic generated artifact that must be regenerated. The committed operation count is an observation only; it is never a schema cardinality.

### Accepted-intent validation

An accepted-intent record is valid only when all conditions hold:

1. Its revision is immutable and its source bytes have a full digest.
2. It names the exact `row_id` or exact canonical signature set affected.
3. It names the exact disposition kind and a bounded scope.
4. It names the selected legacy and mono revisions.
5. It links to the source or accepted journey contract that explains the disposition.
6. It does not contain credentials, personal data, raw payloads, or copied authority tables.
7. It is not stale relative to the source manifest or artifact hash.
8. It does not attempt to waive duplicate, stale, unresolved, or uncovered status.

A missing, malformed, broad, stale, or conflicting intent reference is `accepted_intent_invalid`. The generator does not decide whether the intent is wise or correct; it reports only structural and provenance validity.

## One exact maintainer journey

This is the only maintainer journey in the contract. It is serialized. A step cannot be skipped because a count looks correct.

### J0 — Establish source isolation

1. Start in the repository root at the selected full mono revision. The initial implementation checkpoint is the 0023 baseline `462691d4c31ed601fba01f8b5f21abb92a547ff9`.
2. Record the branch, worktree, full revision, legacy root identity, selected intent revision, generator version, and command in execution evidence only.
3. Confirm that the legacy root is readable and read-only. Do not write, install, migrate, seed, or delete in that root.
4. Confirm that provider credentials, `.env` files, production endpoints, raw backups, personal data, and external integration payloads are not inputs.
5. Create an isolated temporary output directory outside the repository. Do not use its absolute path in deterministic bytes.

If source isolation fails, emit `source_unavailable` with a sanitized reason such as `UNSAFE_SOURCE` and stop before parsing.

### J1 — Freeze and hash every source family

1. Bind `legacy` to the exact `--legacy-root` and `mono` to the exact `--root`; record both in `census_roots` with `scan_mode: "all_regular_files"`.
2. Enumerate every regular file below both full roots before applying parity-source selectors. Evaluate the ordered residual ignore register first, with dependency and generated-output rules winning structurally, then evaluate one `**/*` census family and the first-party source selectors.
3. Expand each required parity-source pattern to POSIX-relative paths, sort by byte order, de-duplicate, and hash exact bytes.
4. Record revision refs, source refs, byte lengths, line spans when known, and unavailable-path failures.
5. Write one `root_census` record per root file with its exact relative path, byte length/digest, availability, classification, source refs, and effective ignore-rule ref. Fail on a dropped path, parser-only omission, or a second classification after normalization; do not fail raw predicate overlap.
6. Read accepted-intent and journey references as immutable inputs. Record their exact hashes and revisions.
7. Keep OpenAPI as a projection input. Never treat its rows as the API authority.

A source manifest is complete only when both full roots have a classification record for every regular file, every required pattern has a readable result or an explicit unavailable failure, and the pinned-root pattern accounting reports `unclassified_count: 0` as a non-normative observation. An empty schedule family is a visible `absent` observation, and every absent row requires an `accepted_absent` disposition before it can become `accounted`.

### J2 — Collect static declarations

1. Parse legacy YAML route blocks and controller annotations without changing the legacy source.
2. Parse mono routes, API resources, command/write symbols, schedule/background declarations, external integration call sites, and journey refs.
3. Retain every declaration, including vendor/imported, deprecated, methodless, duplicate, and apparently dead rows.
4. Emit a parse reason and source edge when a field is unavailable. Do not infer the field.
5. Redact credentials, tokens, identities, and raw payloads before any row, log, digest, or failure message is written.

### J3 — Collect local runtime observations

The implementation uses local, credential-free collectors at the selected mono revision. Production collection receives a closed `CollectorExecutables` configuration from the public run API and CLI. The CLI accepts `--php-executable` and `--bwrap-executable`; when neither is supplied, `/usr/bin/php` and `/usr/bin/bwrap` are the only defaults and are used only when both canonical files validate. There is no ambient `PATH` lookup.

Before execution, each selected executable is resolved once and must be an absolute, regular executable file with no group/other write bits. The final path must be exactly `/usr/bin/php` or `/usr/bin/bwrap`, or match `/nix/store/<32-character-hash>-php-*/bin/php` or `/nix/store/<32-character-hash>-bubblewrap-*/bin/bwrap`; symlinked or arbitrary paths are rejected. A rejected or missing configuration produces `runtime_unavailable`.

The PHP collector invokes the selected bubblewrap executable directly with an argument vector. It uses `--clearenv`, unshares network, PID, UTS, and IPC namespaces, stages only selected source bytes plus an immutable vendor tree, applies a bounded timeout and output limit, and binds the selected PHP at `/usr/bin/php`. For a Nix-store PHP or bubblewrap, it read-only binds `/nix/store` so the dynamic loader and PHP extensions remain available. Collector arguments are passed after `--`; they are never shell-interpreted.

Runtime observations retain a stable logical command identity, argument/output/result digests, and executable content digests plus logical provenance (`usr-bin` or `nix-store`). Host executable paths do not enter deterministic command identity, canonical keys, or projection bytes. The required observations are:

- resolved mono routes from the framework router collector;
- resolved API operation/resource metadata;
- local command registry and message/handler registrations;
- local scheduler/workflow registration where available;
- regenerated local OpenAPI projection.

The existing H3 route/resource collector is reusable through the explicit derivation in this spec. It is not copied as parity authority. A required collector that cannot run produces `runtime_unavailable`; a collector that runs but cannot resolve a row produces `unresolved`. Fixture runtime payloads are available only to named `fixture_injection` falsifiers; they are out-of-band typed inputs, not census files or production authority, and their logical runtime source reference must not require an ignored-root source digest.

No collector calls an external integration. An external integration runtime observation can only be a separately supplied, redacted, immutable evidence reference.

### J4 — Normalize and assign identities

1. Apply the normalization rules in this document.
2. Create declaration IDs, canonical keys, signatures, row IDs, and duplicate groups.
3. Sort rows and links by the contract keys.
4. Attach source and revision refs to every row.
5. Preserve static and runtime observations as distinct kinds.

An ID collision, duplicate canonical key, missing source edge, or non-canonical scalar is a failure, not an instruction to add a suffix.

### J5 — Reconcile all inventory surfaces

1. Reconcile legacy routes with mono routes.
2. Reconcile API resource declarations, resolved API operations, mono routes, and OpenAPI projection.
3. Reconcile commands and write paths across lines.
4. Reconcile schedules/background workflows and explicit absent-family observations.
5. Reconcile external integrations and their command/write or route call sites.
6. Reconcile user-journey steps to every parity-relevant row.
7. Apply only exact accepted-intent dispositions. Keep mismatch kinds and refs in the output.
8. Detect duplicates, dead/unimported declarations, stale projections, unresolved fields, and uncovered rows.

### J6 — Emit deterministic artifacts and report

1. Serialize each inventory and the report as compact UTF-8 canonical JSON without a terminal newline.
2. Sort object keys recursively and arrays by their specified keys.
3. Schema-validate every artifact with `additionalProperties: false` at every object level.
4. Check cross-artifact invariants: unique row IDs, exact source refs, relation endpoints, accepted-intent coverage, duplicate groups, and report counts.
5. Compute each artifact digest over the exact bytes written; no self-hash or sidecar field is removed.
6. Write the deterministic artifacts to the isolated temporary output directory.
7. In `--write` mode, after schema and cross-artifact checks, atomically replace only the committed projection set: `source-manifest.json` and the seven inventory files. Do not write `openapi-reconciliation.json`, `zero-gap-report.json`, or execution evidence as committed projection files. The regenerated OpenAPI operation set has one artifact home, `openapi-reconciliation.json`. Set `projection_write.status: "written"`, set `verification.deterministic_diff: "not_run"`, and return `projection_written` (exit 14) rather than a parity result.
8. In `--diff` mode, never write. Compare regenerated source-manifest and inventory projection bytes with the committed projection set, and compare the committed OpenAPI input through `openapi-reconciliation.json`. Missing or different committed bytes are `stale`; they are never `nondeterministic_output`. Set `verification.deterministic_diff: "equal"` only when every committed projection byte and the OpenAPI reconciliation are equal. A blocked comparison records `different` and retains the specific failure.
9. Run the two isolated replay required by `F0_deterministic_replay`. Only different bytes for identical inputs produce `nondeterministic_output`.

Bundle validation MUST decode artifact bytes through a non-public shape decoder, re-hash those exact bytes, derive report status/counts/digests/mismatches/cross-references/forbidden-state claims from the decoded artifacts, and derive projection diff from an observed filesystem read of the exact-eight projection closure. It MUST NOT trust caller-supplied report flags, `projectionDiff`, cross-reference booleans, or self-authored terminal claims. The production `run` composition root is the sole public mutation path; terminal stage effects, raw projection writers, and injected observation/writer services are module-private. Test-only seams MUST use a trusted deterministic fixture collector and cannot certify a no-op writer. After every write, the terminal stage MUST re-read all eight files from disk and byte-compare them before returning `projection_written`.
11. Write timestamped execution evidence separately. Execution evidence is not in the deterministic hash chain.

The report is `zero_gap` only after every required row is accounted for and every forbidden status set is empty.

### J7 — Retain evidence and clean temporary material

1. Retain deterministic inventories, the zero-gap report, source-manifest digest, artifact digests, sanitized failure receipts, and execution-evidence reference.
2. Delete temporary directories, raw collector output, unredacted command output, and fixture copies after evidence capture.
3. Do not delete source files, accepted-intent records, committed artifacts, H3 evidence, provider resources, or production data.
4. If cleanup fails, emit `command_error` with a sanitized path class and keep the run nonzero.

## Deterministic artifact and execution-evidence separation

### Deterministic bytes

The deterministic hash chain is:

```text
source bytes
  -> per-file sha256 source refs
  -> canonical source-manifest.json
  -> source_manifest_sha256

static and runtime projection rows
  -> canonical inventory JSON files
  -> inventory artifact digests

all inventory digests, rows, links, and failures
  -> canonical zero-gap-report.json
  -> zero-gap-report artifact digest
```

Deterministic bytes MUST NOT contain `generated_at`, `started_at`, `finished_at`, hostnames, process IDs, branch names, absolute paths, random identifiers, locale-dependent order, environment variables, credentials, personal data, raw requests, or raw responses. They MAY contain logical repository refs, immutable full revisions, relative paths, line numbers, source hashes, command names, and sanitized status codes.

The canonical JSON algorithm is recursive object-key sorting, explicit array sorting per table below, compact `JSON.stringify`-equivalent encoding, UTF-8 bytes, and no terminal newline. Numbers use a single JSON representation. Locale collation is forbidden; byte-order comparison is mandatory.

| Array | Sort key |
|---|---|
| `sources` | `source_id` |
| `census_roots` | `root_ref` |
| `revisions` | `revision_ref_id` |
| `runtime_observations` | `runtime_observation_ref_id` |
| `root_census` | `census_id` |
| `ignore_rules` | `root_ref`, `precedence`, `pattern`, `ignore_rule_id` |
| `rows` | `row_id` then `canonical_key` |
| `links` | `relation_kind`, `from_row_id`, `to_row_id` |
| `derivation_edges` | `edge_id` |
| `reason_codes` | byte order |
| `failure_statuses` | byte order |
| `steps` | `step_id` |
| `accepted_intent_ref_ids` | byte order |

### Timestamped execution evidence

`execution-evidence.json` is a separate, non-deterministic record. It may contain:

- `run_id`, `started_at`, `finished_at`, and duration;
- operator-provided opaque reference;
- absolute worktree and legacy root paths;
- branch and full revision names;
- canonical root command and normalized arguments;
- runtime, operating-system, and tool versions;
- process exit status;
- deterministic artifact hashes;
- sanitized stdout/stderr artifact refs;
- cleanup outcome.

Execution evidence MUST NOT be used as a source authority or included in a deterministic artifact digest. It MUST NOT contain credentials, personal data, raw payloads, or unredacted provider output.

`execution-evidence.json` uses this closed schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "functional-parity-execution-evidence/v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "run_id", "started_at", "finished_at", "duration_ms", "operator_ref", "worktree", "legacy_root", "branch", "revisions", "command", "arguments", "runtime", "exit_code", "status", "deterministic_artifact_sha256", "stdout_ref", "stderr_ref", "cleanup"],
  "properties": {
    "$schema": {"type": "string", "const": "https://json-schema.org/draft/2020-12/schema"},
    "schema_version": {"type": "string", "const": "functional-parity-execution-evidence/v1"},
    "run_id": {"type": "string", "minLength": 1},
    "started_at": {"type": "string", "minLength": 1},
    "finished_at": {"type": "string", "minLength": 1},
    "duration_ms": {"type": "integer", "minimum": 0},
    "operator_ref": {"type": ["string", "null"]},
    "worktree": {"type": "string", "minLength": 1},
    "legacy_root": {"type": "string", "minLength": 1},
    "branch": {"type": "string", "minLength": 1},
    "revisions": {"type": "object", "additionalProperties": false, "patternProperties": {"^[A-Za-z0-9._-]+$": {"type": "string", "minLength": 1}}},
    "command": {"type": "string", "minLength": 1},
    "arguments": {"type": "array", "items": {"type": "string"}},
    "runtime": {
      "type": "object",
      "additionalProperties": false,
      "required": ["runtime_name", "runtime_version", "os", "tool_versions"],
      "properties": {
        "runtime_name": {"type": "string", "minLength": 1},
        "runtime_version": {"type": "string", "minLength": 1},
        "os": {"type": "string", "minLength": 1},
        "tool_versions": {"type": "object", "additionalProperties": false, "patternProperties": {"^[A-Za-z0-9._-]+$": {"type": "string", "minLength": 1}}}
      }
    },
    "exit_code": {"type": "integer"},
    "status": {"type": "string", "minLength": 1},
    "deterministic_artifact_sha256": {"type": "object", "additionalProperties": false, "patternProperties": {"^[A-Za-z0-9._-]+$": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"}}},
    "stdout_ref": {"type": ["string", "null"]},
    "stderr_ref": {"type": ["string", "null"]},
    "cleanup": {"type": "object", "additionalProperties": false, "required": ["status", "detail"], "properties": {"status": {"type": "string", "enum": ["complete", "failed"]}, "detail": {"type": "string", "minLength": 1}}}
  }
}
```

Timestamps, host paths, process data, and runtime versions are allowed only in this execution-evidence record. They never enter a source hash, inventory digest, report digest, or comparison key.

## Machine-readable schemas

The future implementation MUST install byte-equivalent closed JSON Schemas. The following schemas define the contract. Every object has `additionalProperties: false`; implementations cannot add fields without a schema revision.

### Inventory envelope schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "functional-parity-inventory/v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "inventory_kind", "authority_line", "source_manifest_sha256", "revision_ref_ids", "observation_kinds", "rows", "links", "observations", "derivation_edges"],
  "properties": {
    "$schema": {"type": "string", "const": "https://json-schema.org/draft/2020-12/schema"},
    "schema_version": {"type": "string", "const": "functional-parity-inventory/v1"},
    "inventory_kind": {"type": "string", "enum": ["legacy_route", "mono_route", "api_operation", "command_write", "schedule_background", "external_integration", "user_journey"]},
    "authority_line": {"type": "string", "enum": ["legacy", "mono", "cross_line"]},
    "source_manifest_sha256": {"$ref": "#/$defs/sha256"},
    "revision_ref_ids": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
    "observation_kinds": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/observationKind"}},
    "rows": {"type": "array", "items": {"$ref": "#/$defs/row"}},
    "links": {"type": "array", "items": {"$ref": "#/$defs/link"}},
    "observations": {"type": "array", "items": {"$ref": "#/$defs/observation"}},
    "derivation_edges": {"type": "array", "items": {"$ref": "#/$defs/derivationEdge"}}
  },
  "$defs": {
    "sha256": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
    "observationKind": {"type": "string", "enum": ["static_source", "runtime_resolution", "runtime_evidence", "generated_projection", "accepted_intent", "derived_h3"]},
    "rowStatus": {"type": "string", "enum": ["covered", "accounted", "missing", "extra", "changed", "uncovered", "unresolved", "duplicate", "stale", "dead_unimported", "absent", "not_applicable"]},
    "mismatchKind": {"type": "string", "enum": ["none", "missing", "extra", "changed", "renamed", "split", "merged", "dead_unimported", "absent", "uncovered", "unresolved", "duplicate", "stale", "openapi_stale"]},
    "mismatch": {
      "type": "object", "additionalProperties": false,
      "required": ["kind", "disposition", "accepted_intent_ref_ids"],
      "properties": {
        "kind": {"$ref": "#/$defs/mismatchKind"},
        "disposition": {"type": "string", "enum": ["none", "accepted_missing", "accepted_extra", "accepted_changed", "accepted_renamed", "accepted_split", "accepted_merged", "accepted_dead_source", "accepted_absent", "accepted_not_applicable", "rejected"]},
        "accepted_intent_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "counterpart_row_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "reason": {"type": ["string", "null"], "maxLength": 500}
      },
      "allOf": [
        {"if": {"properties": {"disposition": {"enum": ["accepted_missing", "accepted_extra", "accepted_changed", "accepted_renamed", "accepted_split", "accepted_merged", "accepted_dead_source", "accepted_absent", "accepted_not_applicable"]}}}, "then": {"properties": {"accepted_intent_ref_ids": {"minItems": 1}}}},
        {"if": {"properties": {"disposition": {"enum": ["none", "rejected"]}}}, "then": {"properties": {"accepted_intent_ref_ids": {"maxItems": 0}}}},
        {"if": {"properties": {"kind": {"const": "absent"}}}, "then": {"properties": {"disposition": {"const": "accepted_absent"}, "accepted_intent_ref_ids": {"minItems": 1}}}}
      ]
    },
    "row": {
      "type": "object", "additionalProperties": false,
      "required": ["row_id", "declaration_id", "inventory_kind", "authority_line", "canonical_key", "signature", "status", "observation_kinds", "source_ref_ids", "revision_ref_ids", "runtime_observation_ref_ids", "coverage_ref_ids", "accepted_intent_ref_ids", "duplicate_group_id", "mismatch", "reason_codes", "related_row_ids", "details"],
      "properties": {
        "row_id": {"type": "string", "pattern": "^row-[a-f0-9]{64}$"},
        "declaration_id": {"type": "string", "pattern": "^decl-[a-f0-9]{64}$"},
        "inventory_kind": {"type": "string", "enum": ["legacy_route", "mono_route", "api_operation", "command_write", "schedule_background", "external_integration", "user_journey"]},
        "authority_line": {"type": "string", "enum": ["legacy", "mono", "cross_line"]},
        "canonical_key": {"type": "string", "minLength": 1},
        "signature": {"type": "string", "minLength": 1},
        "status": {"$ref": "#/$defs/rowStatus"},
        "observation_kinds": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/observationKind"}},
        "source_ref_ids": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "revision_ref_ids": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "runtime_observation_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "coverage_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "accepted_intent_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "duplicate_group_id": {"type": ["string", "null"], "pattern": "^dup-[a-f0-9]{64}$"},
        "mismatch": {"$ref": "#/$defs/mismatch"},
        "reason_codes": {"type": "array", "uniqueItems": true, "items": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{2,63}$"}},
        "related_row_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "pattern": "^row-[a-f0-9]{64}$"}},
        "details": {}
      },
      "allOf": [
        {"if": {"properties": {"inventory_kind": {"const": "legacy_route"}}}, "then": {"properties": {"details": {"$ref": "#/$defs/legacyRouteDetails"}}}},
        {"if": {"properties": {"inventory_kind": {"const": "mono_route"}}}, "then": {"properties": {"details": {"$ref": "#/$defs/monoRouteDetails"}}}},
        {"if": {"properties": {"inventory_kind": {"const": "api_operation"}}}, "then": {"properties": {"details": {"$ref": "#/$defs/apiOperationDetails"}}}},
        {"if": {"properties": {"inventory_kind": {"const": "command_write"}}}, "then": {"properties": {"details": {"$ref": "#/$defs/commandWriteDetails"}}}},
        {"if": {"properties": {"inventory_kind": {"const": "schedule_background"}}}, "then": {"properties": {"details": {"$ref": "#/$defs/scheduleBackgroundDetails"}}}},
        {"if": {"properties": {"inventory_kind": {"const": "external_integration"}}}, "then": {"properties": {"details": {"$ref": "#/$defs/externalIntegrationDetails"}}}},
        {"if": {"properties": {"inventory_kind": {"const": "user_journey"}}}, "then": {"properties": {"details": {"$ref": "#/$defs/userJourneyDetails"}}}}
      ]
    },
    "link": {
      "type": "object", "additionalProperties": false,
      "required": ["relation_id", "relation_kind", "from_row_id", "to_row_id", "source_ref_ids"],
      "properties": {
        "relation_id": {"type": "string", "pattern": "^rel-[a-f0-9]{64}$"},
        "relation_kind": {"type": "string", "enum": ["matches", "derives", "imports", "covers", "observes", "reconciles"]},
        "from_row_id": {"type": "string", "pattern": "^row-[a-f0-9]{64}$"},
        "to_row_id": {"type": "string", "pattern": "^row-[a-f0-9]{64}$"},
        "source_ref_ids": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "minLength": 1}}
      }
    },
    "observation": {
      "type": "object", "additionalProperties": false,
      "required": ["observation_id", "observation_kind", "source_ref_ids", "value_digest", "normative"],
      "properties": {
        "observation_id": {"type": "string", "pattern": "^obs-[a-f0-9]{64}$"},
        "observation_kind": {"$ref": "#/$defs/observationKind"},
        "source_ref_ids": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "value_digest": {"$ref": "#/$defs/sha256"},
        "normative": {"type": "boolean", "const": false},
        "label": {"type": "string", "minLength": 1, "maxLength": 200},
        "count": {"type": ["integer", "null"], "minimum": 0}
      }
    },
    "derivationEdge": {
      "type": "object", "additionalProperties": false,
      "required": ["edge_id", "edge_type", "from_ref_ids", "to_row_ids", "derivation"],
      "properties": {
        "edge_id": {"type": "string", "pattern": "^edge-[a-f0-9]{64}$"},
        "edge_type": {"type": "string", "enum": ["authority_input", "observed_inventory", "derived_projection", "reconciles", "coverage", "accepted_intent"]},
        "from_ref_ids": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "to_row_ids": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "pattern": "^row-[a-f0-9]{64}$"}},
        "derivation": {"type": "string", "minLength": 1, "maxLength": 500}
      }
    },
    "legacyRouteDetails": {
      "type": "object", "additionalProperties": false,
      "required": ["declaration_kind", "route_name", "path_template", "method", "methods_declared", "controller_ref", "import_ref", "deprecated"],
      "properties": {
        "declaration_kind": {"type": "string", "enum": ["yaml_route_block", "controller_annotation", "imported_route", "vendor_route", "unknown"]},
        "route_name": {"type": ["string", "null"]},
        "path_template": {"type": ["string", "null"]},
        "method": {"type": ["string", "null"], "pattern": "^[A-Z]+$"},
        "methods_declared": {"type": "array", "uniqueItems": true, "items": {"type": "string", "pattern": "^[A-Z]+$"}},
        "controller_ref": {"type": ["string", "null"]},
        "import_ref": {"type": ["string", "null"]},
        "deprecated": {"type": "boolean"}
      }
    },
    "monoRouteDetails": {
      "type": "object", "additionalProperties": false,
      "required": ["declaration_kind", "route_origin", "route_name", "path_template", "method", "owner_ref", "runtime_resolved", "imported_from_ref"],
      "properties": {
        "declaration_kind": {"type": "string", "enum": ["controller_attribute", "api_platform", "imported_route", "vendor_route", "unknown"]},
        "route_origin": {"type": "string", "enum": ["controller", "api_platform", "imported", "vendor"]},
        "route_name": {"type": ["string", "null"]},
        "path_template": {"type": ["string", "null"]},
        "method": {"type": ["string", "null"], "pattern": "^[A-Z]+$"},
        "owner_ref": {"type": ["string", "null"]},
        "runtime_resolved": {"type": "boolean"},
        "imported_from_ref": {"type": ["string", "null"]}
      }
    },
    "apiOperationDetails": {
      "type": "object", "additionalProperties": false,
      "required": ["resource_class_ref", "resource_key", "operation_name", "method", "uri_template", "operation_id", "provider_ref", "processor_ref", "schema_ref", "openapi_projection_ref"],
      "properties": {
        "resource_class_ref": {"type": ["string", "null"]},
        "resource_key": {"type": ["string", "null"]},
        "operation_name": {"type": ["string", "null"]},
        "method": {"type": ["string", "null"], "pattern": "^[A-Z]+$"},
        "uri_template": {"type": ["string", "null"]},
        "operation_id": {"type": ["string", "null"]},
        "provider_ref": {"type": ["string", "null"]},
        "processor_ref": {"type": ["string", "null"]},
        "schema_ref": {"type": ["string", "null"]},
        "openapi_projection_ref": {"type": ["string", "null"]}
      }
    },
    "commandWriteDetails": {
      "type": "object", "additionalProperties": false,
      "required": ["entry_kind", "owner_ref", "command_name", "symbol_ref", "effect_classes", "target_refs", "write_contract_ref"],
      "properties": {
        "entry_kind": {"type": "string", "enum": ["custom_command", "controller_write", "repository_write", "api_processor", "event_handler", "message_consumer", "integration_write", "unknown"]},
        "owner_ref": {"type": ["string", "null"]},
        "command_name": {"type": ["string", "null"]},
        "symbol_ref": {"type": ["string", "null"]},
        "effect_classes": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "enum": ["read_only", "durable_write", "identity_or_authority", "outbound", "filesystem", "scheduler", "unknown"]}},
        "target_refs": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "write_contract_ref": {"type": ["string", "null"]}
      }
    },
    "scheduleBackgroundDetails": {
      "type": "object", "additionalProperties": false,
      "required": ["trigger_kind", "trigger_identity", "schedule_expression", "owner_ref", "handler_ref", "enabled", "repository_owned", "runtime_registered"],
      "properties": {
        "trigger_kind": {"type": "string", "enum": ["cron", "queue", "event", "manual", "workflow_dispatch", "startup", "webhook", "unknown"]},
        "trigger_identity": {"type": ["string", "null"]},
        "schedule_expression": {"type": ["string", "null"]},
        "owner_ref": {"type": ["string", "null"]},
        "handler_ref": {"type": ["string", "null"]},
        "enabled": {"type": ["boolean", "null"]},
        "repository_owned": {"type": "boolean"},
        "runtime_registered": {"type": ["boolean", "null"]}
      }
    },
    "externalIntegrationDetails": {
      "type": "object", "additionalProperties": false,
      "required": ["provider_ref", "direction", "protocol", "endpoint_ref", "credential_slot_ref", "call_site_ref", "contract_ref", "effect_classes"],
      "properties": {
        "provider_ref": {"type": ["string", "null"]},
        "direction": {"type": "string", "enum": ["inbound", "outbound", "bidirectional"]},
        "protocol": {"type": ["string", "null"]},
        "endpoint_ref": {"type": ["string", "null"]},
        "credential_slot_ref": {"type": ["string", "null"]},
        "call_site_ref": {"type": ["string", "null"]},
        "contract_ref": {"type": ["string", "null"]},
        "effect_classes": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "enum": ["read_only", "durable_write", "identity_or_authority", "outbound", "filesystem", "scheduler", "unknown"]}}
      }
    },
    "userJourneyDetails": {
      "type": "object", "additionalProperties": false,
      "required": ["journey_ref_id", "journey_key", "intent_ref_id", "steps", "coverage_scope"],
      "properties": {
        "journey_ref_id": {"type": "string", "minLength": 1},
        "journey_key": {"type": "string", "minLength": 1},
        "intent_ref_id": {"type": "string", "minLength": 1},
        "steps": {
          "type": "array", "items": {
            "type": "object", "additionalProperties": false,
            "required": ["step_id", "surface", "row_ids", "canonical_signatures", "expected_contract_ref", "runtime_evidence_ref_ids"],
            "properties": {
              "step_id": {"type": "string", "minLength": 1},
              "surface": {"type": "string", "enum": ["legacy_route", "mono_route", "api_operation", "command_write", "schedule_background", "external_integration"]},
              "row_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "pattern": "^row-[a-f0-9]{64}$"}},
              "canonical_signatures": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
              "expected_contract_ref": {"type": ["string", "null"]},
              "runtime_evidence_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}}
            },
            "allOf": [
              {"anyOf": [
                {"properties": {"row_ids": {"minItems": 1}}},
                {"properties": {"canonical_signatures": {"minItems": 1}}}
              ]}
            ]
          }
        },
        "coverage_scope": {"type": "string", "enum": ["user_visible", "operator_visible", "background", "accepted_non_user_facing"]}
      }
      }
    }
}
```

The schema's `details` object is closed per inventory file. The implementation MUST publish byte-equivalent per-kind detail definitions for `legacy_route`, `mono_route`, `api_operation`, `command_write`, `schedule_background`, `external_integration`, and `user_journey`. The required fields are the fields in the artifact sections above; omitted detail fields are schema errors. Cross-object invariants below are not expressible as ordinary JSON Schema and are mandatory generator checks.

`source-manifest.json` uses `functional-parity-source-manifest/v1` with `additionalProperties: false` at every object level. It requires `schema_version`, `manifest_id`, `source_set`, `census_roots`, `revisions`, `runtime_observations`, `root_census`, `ignore_rules`, `sources`, and `source_set_sha256`. Each census root requires `root_ref`, `authority_line`, `repository_ref`, `revision_ref_id`, `root_kind: "repository"`, and `scan_mode: "all_regular_files"`. Each revision requires `revision_ref_id`, `repository_ref`, `revision_kind`, `revision`, and `immutable: true`. Each runtime observation requires `runtime_observation_ref_id`, `revision_ref_id`, `collector_kind`, `logical_command_id`, `command`, `argument_digest`, `executable_digests`, `executable_provenance`, `stdout_sha256`, `stderr_sha256`, `exit_code`, `result_sha256`, and `availability`; an observation or source can include `out_of_band: true` for typed fixture evidence that is excluded from the root census and source-set digest. Each ignore rule requires `ignore_rule_id`, `authority_line`, `root_ref`, `precedence`, literal `pattern`, `selection: "ordered_set_difference"`, `rule_kind`, and `rationale`; its effective predicate is the ordered set difference of its literal match from earlier rules in the same root, and its rationale MUST equal the normative `Rationale` value for the root-scoped tuple. Each root-census record requires `census_id`, `authority_line`, `root_ref`, `path`, `byte_length`, `sha256`, `availability`, `classification`, `source_ref_ids`, and `ignore_rule_id`. Each source requires `source_id`, `authority_line`, `authority_role`, `repository_ref`, `revision_ref_id`, `path`, `line_start`, `line_end`, `symbol`, `byte_length`, `sha256`, `capture_mode`, `availability`, and `classification_status`.


```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "functional-parity-source-manifest/v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "manifest_id", "source_set", "census_roots", "revisions", "runtime_observations", "root_census", "ignore_rules", "sources", "source_set_sha256"],
  "properties": {
    "$schema": {"type": "string", "const": "https://json-schema.org/draft/2020-12/schema"},
    "schema_version": {"type": "string", "const": "functional-parity-source-manifest/v1"},
    "manifest_id": {"type": "string", "pattern": "^source-manifest-[a-f0-9]{64}$"},
    "source_set": {"type": "string", "minLength": 1},
    "census_roots": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": {"$ref": "#/$defs/censusRoot"},
      "allOf": [
        {"contains": {"properties": {"root_ref": {"const": "legacy"}}}},
        {"contains": {"properties": {"root_ref": {"const": "mono"}}}}
      ]
    },
    "revisions": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/revision"}},
    "runtime_observations": {"type": "array", "uniqueItems": true, "items": {"$ref": "#/$defs/runtimeObservation"}},
    "root_census": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/rootCensus"}},
    "ignore_rules": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/ignoreRule"}},
    "sources": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"$ref": "#/$defs/source"}},
    "source_set_sha256": {"$ref": "#/$defs/sha256"},
    "intent_authority": {"$ref": "#/$defs/intentAuthority"}
  },
  "$defs": {
    "sha256": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
    "censusRoot": {
      "type": "object",
      "additionalProperties": false,
      "required": ["root_ref", "authority_line", "repository_ref", "revision_ref_id", "root_kind", "scan_mode"],
      "properties": {
        "root_ref": {"type": "string", "enum": ["legacy", "mono"]},
        "authority_line": {"type": "string", "enum": ["legacy", "mono"]},
        "repository_ref": {"type": "string", "minLength": 1},
        "revision_ref_id": {"type": "string", "minLength": 1},
        "root_kind": {"type": "string", "const": "repository"},
        "scan_mode": {"type": "string", "const": "all_regular_files"}
      },
      "allOf": [
        {"if": {"properties": {"root_ref": {"const": "legacy"}}}, "then": {"properties": {"authority_line": {"const": "legacy"}}}},
        {"if": {"properties": {"root_ref": {"const": "mono"}}}, "then": {"properties": {"authority_line": {"const": "mono"}}}}
      ]
    },
    "revision": {
      "type": "object",
      "additionalProperties": false,
      "required": ["revision_ref_id", "repository_ref", "revision_kind", "revision", "immutable"],
      "properties": {
        "revision_ref_id": {"type": "string", "minLength": 1},
        "repository_ref": {"type": "string", "minLength": 1},
        "revision_kind": {"type": "string", "enum": ["git_commit", "archive_digest", "file_set_digest"]},
        "revision": {"type": "string", "minLength": 1},
        "immutable": {"type": "boolean", "const": true}
      }
    },
    "runtimeObservation": {
      "type": "object",
      "additionalProperties": false,
      "required": ["runtime_observation_ref_id", "revision_ref_id", "collector_kind", "logical_command_id", "command", "argument_digest", "executable_digests", "executable_provenance", "stdout_sha256", "stderr_sha256", "exit_code", "result_sha256", "availability"],
      "properties": {
        "runtime_observation_ref_id": {"type": "string", "minLength": 1},
        "revision_ref_id": {"type": "string", "minLength": 1},
        "collector_kind": {"type": "string", "minLength": 1},
        "logical_command_id": {"type": "string", "minLength": 1},
        "command": {"type": "string", "minLength": 1},
        "argument_digest": {"$ref": "#/$defs/sha256"},
        "executable_digests": {
          "type": "object", "additionalProperties": false,
          "required": ["php", "bwrap"],
          "properties": {
            "php": {"anyOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]},
            "bwrap": {"anyOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]}
          }
        },
        "executable_provenance": {
          "type": "object", "additionalProperties": false,
          "required": ["php", "bwrap"],
          "properties": {
            "php": {"enum": ["usr-bin", "nix-store", null]},
            "bwrap": {"enum": ["usr-bin", "nix-store", null]}
          }
        },
        "stdout_sha256": {"$ref": "#/$defs/sha256"},
        "stderr_sha256": {"$ref": "#/$defs/sha256"},
        "exit_code": {"type": "integer"},
        "result_sha256": {"$ref": "#/$defs/sha256"},
        "availability": {"type": "string", "enum": ["available", "unavailable"]},
        "out_of_band": {"type": "boolean", "const": true}
      }
    },
    "ignoreRule": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ignore_rule_id", "authority_line", "root_ref", "precedence", "pattern", "selection", "rule_kind", "rationale"],
      "properties": {
        "ignore_rule_id": {"type": "string", "pattern": "^ignore-[a-f0-9]{64}$"},
        "authority_line": {"type": "string", "enum": ["legacy", "mono"]},
        "root_ref": {"type": "string", "enum": ["legacy", "mono"]},
        "precedence": {"type": "integer", "minimum": 0},
        "pattern": {"type": "string", "minLength": 1, "not": {"pattern": "^(vendor|node_modules)/"}},
        "selection": {"type": "string", "const": "ordered_set_difference"},
        "rule_kind": {"type": "string", "enum": ["repository_metadata", "dependency_cache", "runtime_cache", "runtime_log", "build_cache", "generated_output", "test_support", "binary_tool"]},
        "rationale": {"type": "string", "minLength": 1, "maxLength": 300}
      },
      "allOf": [
        {"if": {"properties": {"root_ref": {"const": "legacy"}}}, "then": {"properties": {"authority_line": {"const": "legacy"}}}},
        {"if": {"properties": {"root_ref": {"const": "mono"}}}, "then": {"properties": {"authority_line": {"const": "mono"}}}}
      ]
    },
    "rootCensus": {
      "type": "object",
      "additionalProperties": false,
      "required": ["census_id", "authority_line", "root_ref", "path", "byte_length", "sha256", "availability", "classification", "source_ref_ids", "ignore_rule_id"],
      "properties": {
        "census_id": {"type": "string", "pattern": "^census-[a-f0-9]{64}$"},
        "authority_line": {"type": "string", "enum": ["legacy", "mono"]},
        "root_ref": {"type": "string", "enum": ["legacy", "mono"]},
        "path": {"type": "string", "minLength": 1},
        "byte_length": {"type": ["integer", "null"], "minimum": 0},
        "sha256": {"anyOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]},
        "availability": {"type": "string", "enum": ["available", "unavailable"]},
        "classification": {"type": "string", "enum": ["matched", "ignored", "unclassified"]},
        "source_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "ignore_rule_id": {"type": ["string", "null"], "pattern": "^ignore-[a-f0-9]{64}$"}
      },
      "allOf": [
        {"if": {"properties": {"root_ref": {"const": "legacy"}}}, "then": {"properties": {"authority_line": {"const": "legacy"}}}},
        {"if": {"properties": {"root_ref": {"const": "mono"}}}, "then": {"properties": {"authority_line": {"const": "mono"}}}},
        {"if": {"properties": {"classification": {"const": "matched"}}}, "then": {"properties": {"source_ref_ids": {"minItems": 1}, "ignore_rule_id": {"type": "null"}}}},
        {"if": {"properties": {"classification": {"const": "ignored"}}}, "then": {"properties": {"byte_length": {"type": "null"}, "sha256": {"type": "null"}, "source_ref_ids": {"maxItems": 0}, "ignore_rule_id": {"pattern": "^ignore-[a-f0-9]{64}$"}}, "required": ["ignore_rule_id"]}},
        {"if": {"properties": {"classification": {"const": "unclassified"}}}, "then": {"properties": {"source_ref_ids": {"minItems": 1}, "ignore_rule_id": {"type": "null"}}}},
        {"if": {"properties": {"availability": {"const": "unavailable"}}}, "then": {"properties": {"byte_length": {"type": "null"}, "sha256": {"type": "null"}}}}
      ]
    },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "required": ["source_id", "authority_line", "authority_role", "repository_ref", "revision_ref_id", "path", "line_start", "line_end", "symbol", "byte_length", "sha256", "capture_mode", "availability", "classification_status"],
      "properties": {
        "source_id": {"type": "string", "pattern": "^src-[a-f0-9]{64}$"},
        "authority_line": {"type": "string", "enum": ["legacy", "mono", "cross_line"]},
        "authority_role": {"type": "string", "minLength": 1},
        "repository_ref": {"type": "string", "minLength": 1},
        "revision_ref_id": {"type": "string", "minLength": 1},
        "path": {"type": "string", "minLength": 1},
        "line_start": {"type": ["integer", "null"], "minimum": 1},
        "line_end": {"type": ["integer", "null"], "minimum": 1},
        "symbol": {"type": ["string", "null"], "minLength": 1},
        "byte_length": {"type": ["integer", "null"], "minimum": 0},
        "sha256": {"anyOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]},
        "capture_mode": {"type": "string", "enum": ["static", "runtime", "generated", "accepted_intent"]},
        "availability": {"type": "string", "enum": ["available", "unavailable"]},
        "classification_status": {"type": "string", "enum": ["classified", "unclassified"]},
        "out_of_band": {"type": "boolean", "const": true},
        "failure_status": {"type": ["string", "null"], "enum": ["source_unavailable", "unresolved", null]},
        "failure_reason": {"type": ["string", "null"], "pattern": "^[A-Z][A-Z0-9_]{2,63}$"}
      },
      "allOf": [
        {"if": {"properties": {"availability": {"const": "available"}}}, "then": {"properties": {"sha256": {"$ref": "#/$defs/sha256"}}}},
        {"if": {"properties": {"availability": {"const": "unavailable"}}}, "then": {"properties": {"sha256": {"type": "null"}, "failure_status": {"enum": ["source_unavailable", "unresolved"]}}, "required": ["failure_status", "failure_reason"]}},
        {"if": {"properties": {"classification_status": {"const": "unclassified"}}}, "then": {"required": ["failure_status", "failure_reason"]}}
      ]
    },
    "intentAuthority": {
      "type": "object",
      "additionalProperties": false,
      "required": ["repository_ref", "authority_path", "revision_ref_id", "revision", "blob_oid", "digest", "immutable"],
      "properties": {
        "repository_ref": {"type": "string", "const": "external_intent_authority"},
        "authority_path": {"type": "string", "minLength": 1},
        "revision_ref_id": {"type": "string", "pattern": "^rev-[A-Za-z0-9:_-]{1,160}$"},
        "revision": {"type": "string", "pattern": "^[0-9a-f]{40}$"},
        "blob_oid": {"type": "string", "pattern": "^[0-9a-f]{40}$"},
        "digest": {"$ref": "#/$defs/sha256"},
        "immutable": {"type": "boolean", "const": true}
      }
    }
  }
}
```

The source-manifest schema binds every source row to an immutable revision and every census decision to the closed ignore-rule register. An available source has a digest even when it is unclassified; an unclassified source receives `UNCLASSIFIED_SOURCE` and status `unresolved`. An unavailable source may have a null digest and blocks `zero_gap`.

### OpenAPI reconciliation schema

`openapi-reconciliation.json` is a deterministic run artifact with this closed contract:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "functional-parity-openapi-reconciliation/v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "status", "source_manifest_sha256", "committed_source_ref_ids", "regenerated_source_ref_ids", "committed_sha256", "regenerated_sha256", "only_committed", "only_regenerated", "changed_operations"],
  "properties": {
    "$schema": {"type": "string", "const": "https://json-schema.org/draft/2020-12/schema"},
    "schema_version": {"type": "string", "const": "functional-parity-openapi-reconciliation/v1"},
    "status": {"type": "string", "enum": ["current", "stale", "unresolved"]},
    "source_manifest_sha256": {"anyOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]},
    "committed_source_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
    "regenerated_source_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
    "committed_sha256": {"anyOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]},
    "regenerated_sha256": {"anyOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]},
    "only_committed": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
    "only_regenerated": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
    "changed_operations": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}}
  },
  "allOf": [
    {
      "if": {"properties": {"status": {"const": "current"}}},
      "then": {
        "properties": {
          "source_manifest_sha256": {"$ref": "#/$defs/sha256"},
          "committed_source_ref_ids": {"minItems": 1},
          "regenerated_source_ref_ids": {"minItems": 1},
          "committed_sha256": {"$ref": "#/$defs/sha256"},
          "regenerated_sha256": {"$ref": "#/$defs/sha256"},
          "only_committed": {"maxItems": 0},
          "only_regenerated": {"maxItems": 0},
          "changed_operations": {"maxItems": 0}
        }
      }
    },
    {
      "if": {"properties": {"status": {"enum": ["stale", "unresolved"]}}},
      "then": {"properties": {"source_manifest_sha256": {"anyOf": [{"$ref": "#/$defs/sha256"}, {"type": "null"}]}}}
    }
  ],
  "$defs": {
    "sha256": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"}
  }
}
```

`status: "current"` requires both source-ref arrays and both digests. `status: "stale"` is emitted for any committed/regenerated operation difference, source-revision drift, missing committed projection, or regeneration failure. The artifact is not an authority for API operations.

### Zero-gap report schema

`zero-gap-report.json` uses this closed top-level contract:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "functional-parity-zero-gap-report/v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "status", "exit_code", "mode", "falsifier_id", "projection_write", "source_manifest_sha256", "inventory_artifact_sha256", "row_counts", "status_counts", "failures", "mismatches", "openapi_reconciliation_ref", "verification"],
  "properties": {
    "$schema": {"type": "string", "const": "https://json-schema.org/draft/2020-12/schema"},
    "schema_version": {"type": "string", "const": "functional-parity-zero-gap-report/v1"},
    "status": {"type": "string", "enum": ["zero_gap", "falsifier_passed", "projection_written", "gaps_found", "unresolved", "duplicate", "stale", "source_unavailable", "source_hash_drift", "schema_invalid", "nondeterministic_output", "runtime_unavailable", "accepted_intent_invalid", "command_error"]},
    "exit_code": {"type": "integer", "enum": [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]},
    "mode": {"type": "string", "enum": ["diff", "write", "fixture_injection"]},
    "falsifier_id": {"type": ["string", "null"], "enum": [null, "F0_deterministic_replay", "F1_missing_required_source", "F2_source_hash_drift", "F3_duplicate_legacy_route", "F4_dead_unimported_source", "F5_missing_counterpart", "F6_extra_counterpart", "F7_method_path_mismatch", "F8_openapi_stale", "F9_runtime_unavailable", "F10_static_runtime_mismatch", "F11_intent_missing_or_stale", "F12_uncovered_journey", "F13_unknown_effect", "F14_absent_schedule", "F15_secret_or_pii_input", "F16_h3_authority_copy", "F17_locale_order", "F18_stale_artifact_diff", "F19_ignore_residual_precedence"]},
    "projection_write": {"$ref": "#/$defs/projectionWrite"},
    "source_manifest_sha256": {"type": ["string", "null"], "pattern": "^sha256:[0-9a-f]{64}$"},
    "inventory_artifact_sha256": {"type": "object", "patternProperties": {"^[A-Za-z0-9._-]+$": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"}}, "additionalProperties": false},
    "row_counts": {"type": "object", "patternProperties": {"^[A-Za-z0-9._-]+$": {"type": "integer", "minimum": 0}}, "additionalProperties": false},
    "status_counts": {"type": "object", "patternProperties": {"^[A-Za-z0-9._-]+$": {"type": "integer", "minimum": 0}}, "additionalProperties": false},
    "failures": {"type": "array", "items": {"$ref": "#/$defs/failure"}},
    "mismatches": {"type": "array", "items": {"$ref": "#/$defs/mismatch"}},
    "openapi_reconciliation_ref": {"type": "string", "const": "openapi-reconciliation.json"},
    "verification": {"$ref": "#/$defs/verification"}
  },
  "allOf": [
    {
      "if": {"properties": {"status": {"const": "zero_gap"}}},
      "then": {
        "properties": {
          "exit_code": {"const": 0},
          "mode": {"const": "diff"},
          "falsifier_id": {"type": "null"},
          "projection_write": {"properties": {"status": {"const": "not_requested"}}},
          "source_manifest_sha256": {"$ref": "#/$defs/sha256"},
          "inventory_artifact_sha256": {"minProperties": 1},
          "failures": {"maxItems": 0},
          "mismatches": {
            "items": {
              "type": "object",
              "required": ["disposition", "accepted_intent_ref_ids"],
              "properties": {
                "disposition": {"enum": ["accepted_missing", "accepted_extra", "accepted_changed", "accepted_renamed", "accepted_split", "accepted_merged", "accepted_dead_source", "accepted_absent", "accepted_not_applicable"]},
                "accepted_intent_ref_ids": {"minItems": 1}
              },
              "not": {"properties": {"disposition": {"enum": ["none", "rejected"]}}}
            }
          },
          "openapi_reconciliation_ref": {"const": "openapi-reconciliation.json"},
          "verification": {
            "properties": {
              "schema_validation": {"const": true},
              "cross_reference_validation": {"const": true},
              "deterministic_diff": {"const": "equal"},
              "forbidden_states_empty": {"const": true}
            }
          }
        }
      }
    },
    {
      "if": {"properties": {"mode": {"const": "write"}}},
      "then": {"properties": {"falsifier_id": {"type": "null"}, "verification": {"properties": {"deterministic_diff": {"const": "not_run"}}}}}
    },
    {
      "if": {"properties": {"mode": {"const": "diff"}}},
      "then": {"properties": {"falsifier_id": {"type": "null"}, "verification": {"properties": {"deterministic_diff": {"enum": ["equal", "different"]}}}}}
    },
    {
      "if": {"properties": {"mode": {"const": "fixture_injection"}}},
      "then": {
        "required": ["falsifier_id"],
        "properties": {
          "falsifier_id": {"type": "string", "enum": ["F0_deterministic_replay", "F1_missing_required_source", "F2_source_hash_drift", "F3_duplicate_legacy_route", "F4_dead_unimported_source", "F5_missing_counterpart", "F6_extra_counterpart", "F7_method_path_mismatch", "F8_openapi_stale", "F9_runtime_unavailable", "F10_static_runtime_mismatch", "F11_intent_missing_or_stale", "F12_uncovered_journey", "F13_unknown_effect", "F14_absent_schedule", "F15_secret_or_pii_input", "F16_h3_authority_copy", "F17_locale_order", "F18_stale_artifact_diff", "F19_ignore_residual_precedence"]},
          "status": {"not": {"const": "zero_gap"}},
          "projection_write": {"properties": {"status": {"enum": ["not_requested", "blocked"]}}}
        }
      }
    },
    {
      "if": {"properties": {"status": {"const": "falsifier_passed"}}},
      "then": {"properties": {"exit_code": {"const": 13}, "mode": {"const": "fixture_injection"}}}
    }
  ],
  "$defs": {
    "sha256": {"type": "string", "pattern": "^sha256:[0-9a-f]{64}$"},
    "projectionWrite": {
      "type": "object", "additionalProperties": false,
      "required": ["status", "target_ref"],
      "properties": {
        "status": {"type": "string", "enum": ["not_requested", "written", "blocked"]},
        "target_ref": {"type": ["string", "null"], "minLength": 1}
      }
    },
    "failure": {
      "type": "object", "additionalProperties": false,
      "required": ["failure_id", "status", "reason_code", "row_ids", "source_ref_ids"],
      "properties": {
        "failure_id": {"type": "string", "pattern": "^failure-[a-f0-9]{64}$"},
        "status": {"type": "string", "enum": ["gaps_found", "unresolved", "duplicate", "stale", "source_unavailable", "source_hash_drift", "schema_invalid", "nondeterministic_output", "runtime_unavailable", "accepted_intent_invalid", "command_error"]},
        "reason_code": {"type": "string", "pattern": "^[A-Z][A-Z0-9_]{2,63}$"},
        "row_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "pattern": "^row-[a-f0-9]{64}$"}},
        "source_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}},
        "accepted_intent_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}}
      }
    },
    "mismatch": {
      "type": "object", "additionalProperties": false,
      "required": ["kind", "row_ids", "disposition", "accepted_intent_ref_ids"],
      "properties": {
        "kind": {"type": "string", "enum": ["missing", "extra", "changed", "renamed", "split", "merged", "dead_unimported", "absent", "uncovered", "unresolved", "duplicate", "stale", "openapi_stale"]},
        "row_ids": {"type": "array", "minItems": 1, "uniqueItems": true, "items": {"type": "string", "pattern": "^row-[a-f0-9]{64}$"}},
        "disposition": {"type": "string", "enum": ["none", "accepted_missing", "accepted_extra", "accepted_changed", "accepted_renamed", "accepted_split", "accepted_merged", "accepted_dead_source", "accepted_absent", "accepted_not_applicable", "rejected"]},
        "accepted_intent_ref_ids": {"type": "array", "uniqueItems": true, "items": {"type": "string", "minLength": 1}}
      },
      "allOf": [
        {"if": {"properties": {"disposition": {"enum": ["accepted_missing", "accepted_extra", "accepted_changed", "accepted_renamed", "accepted_split", "accepted_merged", "accepted_dead_source", "accepted_absent", "accepted_not_applicable"]}}}, "then": {"properties": {"accepted_intent_ref_ids": {"minItems": 1}}}},
        {"if": {"properties": {"disposition": {"enum": ["none", "rejected"]}}}, "then": {"properties": {"accepted_intent_ref_ids": {"maxItems": 0}}}},
        {"if": {"properties": {"kind": {"const": "absent"}}}, "then": {"properties": {"disposition": {"const": "accepted_absent"}, "accepted_intent_ref_ids": {"minItems": 1}}}}
      ]
    },
    "verification": {
      "type": "object", "additionalProperties": false,
      "required": ["canonical_json", "schema_validation", "cross_reference_validation", "deterministic_diff", "forbidden_states_empty"],
      "properties": {
        "canonical_json": {"type": "string", "const": "recursive-key-sort/byte-order-array-sort/compact-utf8/no-newline"},
        "schema_validation": {"type": "boolean"},
        "cross_reference_validation": {"type": "boolean"},
        "deterministic_diff": {"type": "string", "enum": ["equal", "different", "not_run"]},
        "forbidden_states_empty": {"type": "boolean"}
      }
    }
  }
}
```

The report schema MUST add a cross-field check that `status: "zero_gap"` requires `exit_code: 0`, `mode: "diff"`, `projection_write.status: "not_requested"`, a non-null source-manifest digest, a non-empty artifact-digest map including `openapi-reconciliation.json`, `openapi_reconciliation_ref: "openapi-reconciliation.json"`, `verification.schema_validation: true`, `verification.cross_reference_validation: true`, `verification.deterministic_diff: "equal"`, `verification.forbidden_states_empty: true`, a separate `openapi-reconciliation.json` artifact with `status: "current"` and both source-ref arrays and both digests present, empty `failures`, and no mismatch entry with `disposition: "none"` or `disposition: "rejected"`. Every mismatch entry in a zero-gap report MUST have a non-empty `accepted_intent_ref_ids` array and an allowed accepted disposition. The generator computes `forbidden_states_empty`; it is not trusted from input.

`inventory_artifact_sha256`, `row_counts`, and `status_counts` are maps whose keys are discovered categories. They have no count constants. Counts are accounting output, not acceptance truth.

## Cross-artifact invariants

The generator MUST enforce these invariants after JSON Schema validation:

### Status and mismatch consistency

The generator MUST evaluate `status` and `mismatch.kind` together. It MUST NOT rewrite a forbidden mismatch into `accounted`.

| `mismatch.kind` | Permitted row status | Required disposition |
|---|---|---|
| `none` | `covered` or `not_applicable` | `none` for `covered`; `accepted_not_applicable` plus a non-empty intent ref for `not_applicable` |
| `missing`, `extra`, `changed`, `renamed`, `split`, `merged` | The raw mismatch status, or `accounted` after exact accepted intent | Matching `accepted_*` disposition and a non-empty intent ref for `accounted`; `none` or `rejected` remains a gap |
| `dead_unimported` | `dead_unimported` or `accounted` | `accepted_dead_source` and a non-empty intent ref are required for `accounted` |
| `absent` | `absent` or `accounted` | `accepted_absent` and a non-empty intent ref are required for `accounted`; every absent row needs this disposition |
| `uncovered` | `uncovered` | No disposition can waive missing coverage |
| `unresolved` | `unresolved` | No disposition can waive unresolved provenance or observation |
| `duplicate` | `duplicate` | No disposition can waive a duplicate |
| `stale`, `openapi_stale` | `stale` | No disposition can waive a stale projection |

`status: "accounted"` is forbidden for `uncovered`, `unresolved`, `duplicate`, `stale`, and `openapi_stale`. Invariants 3, 5, 7, and 15 below inspect both fields, not only `status`.

0. For each explicitly named census root (`legacy` and `mono`), every regular file below the full root has exactly one `root_census` record classified as `matched`, `ignored`, or `unclassified`. `matched` and `unclassified` records resolve to source rows; `ignored` records resolve to exactly one effective ordered-residual rule. A normalized duplicate classification, a dropped path, or a path outside all families is `schema_invalid` or `unclassified` and blocks `zero_gap`; raw ignore overlap is resolved by precedence and is not a failure. H3 generator and current inventory evidence remain matched `derived_h3` inputs.
1. Every row ID, source ref ID, revision ref ID, runtime observation ref ID, link endpoint, derivation endpoint, coverage ref, and accepted-intent ref resolves exactly once against the named inventory or source-manifest register.
2. Every row has at least one source ref and immutable revision ref. Runtime rows also have a runtime observation ref.
3. Every canonical key is unique within its authority scope, or every duplicate `status` and `mismatch.kind` is retained with a duplicate group and failure.
4. Every route, API operation, command/write path, schedule/background row, and integration row has a typed signature.
5. Every missing, extra, changed, renamed, split, merged, dead, or absent relation has a matching disposition rule; `absent` always requires `accepted_absent` before it can become `accounted`.
6. Accepted-intent refs cover exact rows and exact source/revision hashes. A stale or broad ref fails.
7. Every parity-relevant row has a coverage ref or an exact accepted non-user-facing ref. The absence of such a ref is `uncovered`, and no intent ref can waive it.
8. Every OpenAPI operation is linked to a regenerated API operation or is listed in a stale diff. OpenAPI-only rows cannot become API authority.
8a. `openapi_reconciliation_ref` resolves exactly to `openapi-reconciliation.json`; that artifact is the sole regenerated OpenAPI reconciliation home. The report carries no second OpenAPI status, digest, operation set, or diff field.
9. Every runtime-only row has a source-unavailable or extra reason; it is never silently imported into source authority.
10. Every source declaration is represented in an import graph. Dead/unimported edges and every unclassified source-manifest row are retained and reported.
11. Every deterministic array uses the declared sort key. Locale collation and hash-map iteration order are forbidden.
12. Deterministic artifact bytes are identical across two runs with identical source bytes and different temporary directories, process IDs, locales, and execution times.
13. No deterministic artifact or execution-evidence record contains secrets, tokens, personal data, raw payloads, or unredacted external response content.
14. No current observation count is used as a fixed schema cardinality.
15. `zero_gap` cannot coexist with a forbidden row status or forbidden `mismatch.kind`: `{missing, extra, changed, uncovered, unresolved, stale, duplicate, dead_unimported, absent}` and `{missing, extra, changed, uncovered, unresolved, stale, openapi_stale, duplicate}`. A `not_applicable` row is allowed only with `mismatch.kind: "none"`, `disposition: "accepted_not_applicable"`, and a non-empty accepted-intent ref. The check evaluates both fields and rejects `none`, `rejected`, or empty intent refs where an accepted disposition is required.

## Reason codes

The implementation uses these stable reason codes. Reason codes describe an observation; they do not grant authority.

| Code | Trigger | Required treatment |
|---|---|---|
| `SOURCE_UNAVAILABLE` | Required file, root, command output, or intent ref cannot be read | Emit sanitized failure; primary status `source_unavailable` |
| `SOURCE_HASH_DRIFT` | Selected bytes differ from a pinned source/revision/manifest | Stop refresh; primary status `source_hash_drift` |
| `SOURCE_PARSE_ERROR` | Parser cannot produce a required field | Retain source ref; row `unresolved` |
| `INVALID_UTF8` | Source is not valid UTF-8 | Do not replace bytes; fail closed |
| `DUPLICATE_CANONICAL_IDENTITY` | Canonical key repeats in one authority scope | Retain duplicate group; primary status `duplicate` |
| `DEAD_UNIMPORTED_SOURCE` | Static declaration has no loader/import edge | Retain row; `dead_unimported` or accepted dead disposition |
| `RUNTIME_ONLY_SOURCE` | Runtime row has no static source edge | Retain as `extra` or `unresolved`; never adopt authority |
| `RUNTIME_UNAVAILABLE` | Required local collector cannot run | Primary status `runtime_unavailable` |
| `STATIC_RUNTIME_MISMATCH` | Static and runtime observations disagree | Retain both edges; `changed` or `unresolved` |
| `METHOD_UNRESOLVED` | Route/API method missing or contradictory | Empty method set; `unresolved` |
| `KEY_KIND_MISMATCH` | A typed identity uses a different key kind or fallback | `unresolved`; no fallback |
| `MISSING_COUNTERPART` | Authority row has no current counterpart | `missing`; accepted intent required |
| `EXTRA_COUNTERPART` | Current row has no authority counterpart | `extra`; accepted intent required |
| `CHANGED_SIGNATURE` | Counterparts differ in typed identity or contract | `changed`; accepted intent required |
| `UNSUPPORTED_SPLIT_OR_MERGE` | A split/merge lacks a bounded intent mapping | `unresolved` or `gaps_found` |
| `STALE_OPENAPI_PROJECTION` | Committed OpenAPI differs from regenerated projection | `stale`; primary status `stale` |
| `STALE_ARTIFACT` | Committed projection bytes differ from regeneration in `--diff` mode | `stale`; never `nondeterministic_output` |
| `ACCEPTED_INTENT_REQUIRED` | Mismatch has no exact accepted disposition | `gaps_found` |
| `ACCEPTED_INTENT_INVALID` | Intent ref is stale, malformed, broad, or conflicting | Primary status `accepted_intent_invalid` |
| `COVERAGE_REF_REQUIRED` | Row has no journey or accepted non-user-facing ref | `uncovered`; always nonzero |
| `ABSENT_SOURCE_FAMILY` | A named source family contains no declarations | Emit `absent` observation; every absent row requires `accepted_absent` and an immutable intent ref before `accounted` |
| `UNKNOWN_EFFECT` | Write or integration effect is untraced | `unresolved`; effect includes `unknown` |
| `UNKNOWN_INTEGRATION` | Provider/protocol/endpoint cannot be resolved | `unresolved`; do not classify as local |
| `UNSAFE_SOURCE` | Credential, secret, PII, or raw payload would enter output | Primary status `source_unavailable`; sanitize the value or stop before any artifact claim |
| `NONDETERMINISTIC_OUTPUT` | Deterministic bytes differ for identical inputs | Primary status `nondeterministic_output` |
| `SCHEMA_INVALID` | Closed schema or cross-reference invariant fails | Primary status `schema_invalid` |
| `H3_DERIVATION_ONLY` | Row came from H3 derivation and retains source edge | Informational; never parity authority |
| `OPENAPI_NOT_AUTHORITY` | OpenAPI row is used as an operation authority | Schema/logic failure; reject the run |

## Explicit H3 derivation

The existing H3 inventory is reusable as a derivation, not as parity authority:

1. Read `apps/server/tools/security-h3/0015/generate.ts` for its canonical JSON and source-hash algorithms.
2. Read `evidence/security-h3/0015/current-route-inventory.json` to derive mono route observations and imported/vendor route rows.
3. Read `evidence/security-h3/0015/current-resource-inventory.json` to derive API resource operation observations.
4. Read the H3 source manifest and route collector digest as source refs. Recompute them at the selected 0023 mono revision when the committed H3 artifact revision differs.
5. Normalize the H3 row fields into this contract's route and API operation details. Retain H3 artifact refs in `derived_h3` observations and `derivation_edges`.
6. Reconcile derived rows against freshly collected static and runtime mono source rows. Do not copy H3 rows as if they were parity authority.
7. Treat H3 side-effect/risk classes as H3 observations only. They do not prove functional behavior, authorization correctness, or parity.

Required derivation edges are:

| Edge | Type | From | To | Meaning |
|---|---|---|---|---|
| `E-H3-ROUTE-DERIVATION` | `observed_inventory` | H3 route inventory and its source/hash refs | mono route rows | Normalize route identity and provenance only |
| `E-H3-RESOURCE-DERIVATION` | `observed_inventory` | H3 resource inventory and its source/hash refs | API operation rows | Normalize resource/operation identity only |
| `E-H3-CANONICALIZATION` | `derived_projection` | H3 generator canonical JSON algorithm | inventory artifacts | Reuse byte algorithm, not H3 authority |
| `E-H3-RECONCILIATION` | `reconciles` | H3-derived rows and fresh mono observations | report rows | Expose drift, missing, extra, or stale H3 evidence |

The preview route contract is a separate derivation source and cannot replace H3 or parity source evidence.

## Falsifiers

Falsifiers run only in isolated `fixture_injection` mode. They use synthetic source refs and cannot mutate, reread, or hash the frozen legacy or mono authority roots. A falsifier result is execution evidence, never a parity approval.
The runnable form is `bun run parity:verify -- --root . --legacy-root /srv/share/projects/vektorprogrammet/vektorprogrammet --mode fixture_injection --falsifier F0_deterministic_replay`. `fixture_injection` requires exactly one ID from the F0–F19 register below, runs against synthetic copies only, never writes committed projections, and returns `falsifier_passed` (exit 13) only when that ID's required result is reached.

| ID | Fixture mutation | Required result |
|---|---|---|
| `F0_deterministic_replay` | Run identical source bytes twice with different temp paths, locales, and execution times | Identical deterministic bytes; otherwise `nondeterministic_output` |
| `F1_missing_required_source` | Remove a required source path | `source_unavailable`; no zero-gap report |
| `F2_source_hash_drift` | Change one source byte after manifest capture | `source_hash_drift`; no refresh |
| `F3_duplicate_legacy_route` | Add a second declaration with the same normalized route signature | Both rows retained; `duplicate` and nonzero |
| `F4_dead_unimported_source` | Add a parseable declaration without a loader/import edge | `dead_unimported` or `unresolved`; row retained |
| `F5_missing_counterpart` | Remove one mono counterpart | `missing`; accepted intent required |
| `F6_extra_counterpart` | Add one mono-only operation | `extra`; accepted intent required |
| `F7_method_path_mismatch` | Change method or path while keeping the source name | `changed`; no path/name fallback |
| `F8_openapi_stale` | Remove or alter one committed OpenAPI operation | `stale` with `STALE_OPENAPI_PROJECTION`; nonzero |
| `F9_runtime_unavailable` | Make a required local collector fail | `runtime_unavailable`; no static-only success |
| `F10_static_runtime_mismatch` | Give static and runtime different method/template values | Both observations retained; `changed` or `unresolved` |
| `F11_intent_missing_or_stale` | Remove or hash-drift an accepted-intent ref | `accepted_intent_invalid` or `gaps_found` |
| `F12_uncovered_journey` | Remove one row from all journey coverage refs | `uncovered`; always nonzero |
| `F13_unknown_effect` | Hide a command or integration target | `unresolved` with `UNKNOWN_EFFECT` or `UNKNOWN_INTEGRATION` |
| `F14_absent_schedule` | Remove a named schedule family without an `accepted_absent` ref | `absent` remains unaccounted and produces `gaps_found`; no inferred schedule |
| `F15_secret_or_pii_input` | Add a token, email, user ID, or payload to a source field | `source_unavailable` with reason `UNSAFE_SOURCE`; forbidden value never appears |
| `F16_h3_authority_copy` | Supply only H3 rows and omit their source/derivation edges | `schema_invalid` or `unresolved`; H3 cannot become authority |
| `F17_locale_order` | Use different locale collations for the same values | Byte-order canonical output remains equal |
| `F18_stale_artifact_diff` | Modify a committed generated artifact without source change | `stale`; regeneration diff is nonzero |
| `F19_ignore_residual_precedence` | Place fixtures in `packages/sdk/dist/module.js`, `packages/sdk/dist/vendor/module.js`, and a nested `node_modules` path | Dependency residuals win inside dependency trees; generated residual wins for `packages/sdk/dist/module.js`; no duplicate classification or external-integration row |

A falsifier is passed only when it reaches the exact required status, retains the affected rows, emits no forbidden value, and exits nonzero for every forbidden state.

## Rollback and cleanup

This spec authorizes no external effect. The future implementation rollback law is:

1. Stop the canonical command when any source, schema, runtime, or cleanup failure occurs.
2. Do not modify the legacy repository, mono source declarations, OpenAPI source, provider resources, production systems, or accepted-intent records to make the report pass.
3. Preserve deterministic artifacts and sanitized execution evidence needed to diagnose the failure.
4. Remove raw temporary collector output, fixture copies, unredacted logs, and temporary directories after evidence capture.
5. If a generated artifact commit is incorrect, revert that artifact commit and regenerate from the same pinned source revision. Do not hand-edit a generated JSON row.
6. If an accepted-intent ref is revoked or stale, retain the mismatch and return to `gaps_found` or `accepted_intent_invalid`; do not infer a replacement.
7. If H3 evidence is stale, retain the derivation failure and regenerate H3 evidence from the selected mono revision; do not copy a newer H3 artifact into the parity output.
8. Do not run account-wide cleanup, provider teardown, database deletion, DNS changes, deployment, or route cutover.
9. Record cleanup success or failure in timestamped execution evidence. Cleanup failure keeps the command nonzero.

## Ordered implementation capsules

This inventory is one dependency graph, not one giant pull request. The implementation proceeds through ordered capsules. Each capsule has one branch, one worktree, one bounded output surface, its own acceptance predicates, and its own falsifier subset. Only capsule `C3` can claim a complete zero-gap report. Every capsule starts from the 0023 baseline and the accepted 0024 spec commit.

### Capsule C0 — closed contract, source manifest, and route surfaces

| Field | Contract |
|---|---|
| Branch | `impl/0024a-parity-contract-routes` |
| Worktree | `/tmp/mono-web-parity-inventory-impl-0024a` |
| Depends on | 0023 baseline `462691d4c31ed601fba01f8b5f21abb92a547ff9` and this spec |
| Owns | Closed inventory/source-manifest schemas, canonical serializer, exhaustive source-family expansion, revision/runtime registers, root command entry, legacy routes, and mono routes |
| Command surface | `bun run parity:verify -- --root . --legacy-root /srv/share/projects/vektorprogrammet/vektorprogrammet --intent-register <authority-checkout>/accepted-intent.json --mode diff` or the same command with `--mode write` |
| Falsifiers | `F0_deterministic_replay`, `F1_missing_required_source`, `F2_source_hash_drift`, `F3_duplicate_legacy_route`, `F4_dead_unimported_source`, `F5_missing_counterpart`, `F6_extra_counterpart`, `F7_method_path_mismatch` |

Acceptance for C0 requires that every object schema is closed, source patterns are literal and exhaustive, recursive controller files are included, unclassified files produce blocking rows, revision and runtime registers resolve all references, declaration IDs do not contain revision or source hashes, route examples validate through `details`, duplicate groups retain all rows, and the canonical serializer produces identical bytes for identical inputs. C0 does not claim API, write, workflow, integration, journey, or zero-gap completion.

### Capsule C1 — API operations, OpenAPI reconciliation, and H3 derivation

| Field | Contract |
|---|---|
| Branch | `impl/0024b-parity-api-openapi-h3` |
| Worktree | `/tmp/mono-web-parity-inventory-impl-0024b` |
| Depends on | C0 integrated at an immutable revision |
| Owns | API resource/operation parser, local runtime API collector, normalized regenerated OpenAPI operation set stored only in `openapi-reconciliation.json`, stale OpenAPI report, and explicit H3 route/resource derivation edges |
| Falsifiers | `F8_openapi_stale`, `F9_runtime_unavailable`, `F10_static_runtime_mismatch`, `F16_h3_authority_copy` |

Acceptance for C1 requires exact API identities, no resource-key fallback, a non-null exact `openapi_reconciliation_ref`, stale projection status and exit 5, runtime register hashes, H3 derivation-only edges, and no H3 or OpenAPI row promoted to authority. C1 does not claim command/write, schedule, integration, journey, or final zero-gap completion.

### Capsule C2 — commands, writes, schedules, and external integrations

| Field | Contract |
|---|---|
| Branch | `impl/0024c-parity-effects-workflows-integrations` |
| Worktree | `/tmp/mono-web-parity-inventory-impl-0024c` |
| Depends on | C0 integrated at an immutable revision; C1 is not required for source parsing |
| Owns | Command/write path inventory, effect classification, schedule/background census, external integration inventory, and import/dead-source edges |
| Falsifiers | `F13_unknown_effect`, `F14_absent_schedule` |

Acceptance for C2 requires literal command/workflow/integration source sets, an `unknown` effect for every untraced path, an explicit absent row for an empty schedule family, an `accepted_absent` ref before any absent row becomes `accounted`, and secret/credential/payload redaction. C2 does not claim user-journey coverage or final zero-gap completion.

### Capsule C3 — journey coverage, report, write/diff modes, and final gate

| Field | Contract |
|---|---|
| Branch | `impl/0024d-parity-report-gate` |
| Worktree | `/tmp/mono-web-parity-inventory-impl-0024d` |
| Depends on | C0, C1, and C2 integrated at immutable revisions |
| Owns | Accepted-intent and journey coverage resolver, cross-artifact invariants, zero-gap report, failure receipts, `--write` projection promotion, `--diff` gate, falsifier receipt aggregation, and cleanup evidence |
| Falsifiers | `F11_intent_missing_or_stale`, `F12_uncovered_journey`, `F15_secret_or_pii_input`, `F17_locale_order`, `F18_stale_artifact_diff`, `F19_ignore_residual_precedence`, plus all earlier capsule falsifiers as integration replays |

Acceptance for C3 requires canonical-signature journey refs that survive source revisions, rejection/empty-intent blocking, status-to-mismatch consistency, exact status/exit mapping including `projection_written` exit 14, `--write` with `deterministic_diff: "not_run"` only in write mode, `--diff` with stale-not-nondeterministic classification, and nonzero exit for every forbidden state. C3 is the first capsule allowed to publish a `zero_gap` report, and it can do so only in `--diff` mode with equal committed projection bytes. It also requires a full internal run-pipeline regeneration proof: write returns exit 14, the exact eight files are committed, a fresh post-commit generation/diff returns exit 0 with equal bytes, and no `GeneratedArtifacts` object is reused across the commit. Forged report/projection-diff/cross-reference claims and no-op writers MUST fail closed.

The root command remains the only supported entry point after C3. `--write` is an explicit reviewed projection-promotion action. `--diff` is the read-only merge/review gate. No capsule adds a route, changes application behavior, uses a credential, calls a provider, or writes the legacy repository.

## Evidence and review boundaries

A maintainer retains these evidence records for one run:

| Evidence | Proves | Does not prove |
|---|---|---|
| Source manifest and revision refs | Exact selected inputs and byte hashes | Semantic correctness or behavior |
| Static inventories | Parsed source declarations and provenance | Runtime registration or response behavior |
| Runtime inventories | One local collector observation at one revision | All environments or user behavior |
| OpenAPI reconciliation | Whether the committed projection is stale for this source | API correctness or client compatibility |
| Zero-gap report | Coverage accounting and exact unresolved/mismatch status | Functional parity, authorization, UX, or business acceptance |
| Accepted-intent refs | A bounded external disposition was supplied | Generator-authenticated business approval |
| User-journey coverage refs | Rows are named by accepted journey steps or explicit non-user-facing scope | The journey ran or behaved correctly |
| Falsifier receipts | The named failure mode remained visible and fail-closed | Unnamed failure modes |
| Execution evidence | When, where, and how one command ran | Deterministic artifact truth or future runs |

A reviewer MUST reject a run that presents a count, committed OpenAPI file, H3 packet, route contract, successful parse, or local route reachability as proof of parity.

## Source index

- 0023 integration baseline: mono revision `462691d4c31ed601fba01f8b5f21abb92a547ff9`.
- Legacy evidence revision observed for this draft: `d05c261e9f73297f70ad228635c85ab566c51526`.
- Existing H3 specification: `design-specs/0015-security-h3-decision-packet.md`.
- Existing H3 generator: `apps/server/tools/security-h3/0015/generate.ts`.
- Existing H3 route inventory: `evidence/security-h3/0015/current-route-inventory.json`.
- Existing H3 resource inventory: `evidence/security-h3/0015/current-resource-inventory.json`.
- Existing H3 source manifest: `evidence/security-h3/0015/source-manifest.json`.
- Committed OpenAPI projection: `packages/sdk/openapi.json`.
- Mono route source families: `apps/server/config/routes.yaml` and `apps/server/src/App/**/Controller/**/*.php`.
- Mono API source families: `apps/server/src/App/**/Api/Resource/**/*.php`, `apps/server/src/App/**/Api/State/**/*.php`, and `apps/server/src/App/**/Infrastructure/Entity/**/*.php`.
- Legacy route source families: `app/config/routing*.yml` and `src/AppBundle/**/Controller/**/*.php`.
- Preview route contract boundary: `infra/preview/routes/route-contract.ts`.

## Final boundary

This contract makes coverage accounting explicit and reproducible. It does not state that a covered route behaves like its counterpart, that an API operation has equivalent data semantics, that a command has equivalent side effects, that an integration is safe, that a schedule runs, or that a user journey succeeds. **Zero-gap inventory proves coverage accounting, not behavior parity.**
