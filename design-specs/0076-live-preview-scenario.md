# Design spec 0076 - live synthetic preview scenario application

## Metadata

| Field                   | Value                                                                        |
| ----------------------- | ---------------------------------------------------------------------------- |
| Status                  | Frozen before implementation                                                 |
| Source repository       | `/tmp/mono-web-final-integration`                                            |
| Source commit           | `73eb5a4c1eb07b513ce103e929c5764ae39047b6`                                   |
| Worktree                | `/tmp/mono-web-preview-live-scenario`                                        |
| Branch                  | `feat/0076-live-preview-scenario`                                            |
| Live mutation authority | Synthetic preview PostgreSQL scenario only; not exercised by this workstream |

## Goal

Provide one repo-owned composition root that can apply the representative scenario from spec 0072
to the synthetic preview PostgreSQL only. The composition root reuses the canonical 0072 scenario
data and application program. It does not copy identities, commands, payloads, or read-back rules.
It has a disposable rehearsal mode that executes the same application function.

This spec grants no authority for production, providers, DNS, credentials, service restarts, deploys,
remote publication, or the live invocation itself.

## Commands and explicit intent

The entrypoint is `infra/host/live-preview-scenario.ts`.

Live mode requires all of these explicit CLI arguments:

- `--mode=live`
- `--target=synthetic-preview`
- `--ack=APPLY-0076-SYNTHETIC-PREVIEW`
- `--database-url=<explicit PostgreSQL URL>`

There is no database URL environment fallback and no default acknowledgment. Rehearsal requires
its own `--mode=rehearsal`, `--target=disposable-preview`, and
`--ack=REHEARSE-0076-DISPOSABLE-PREVIEW` arguments.

Argument parsing rejects duplicate options, unknown options, missing values, and positional input.

## Target allowlists

### Live

The parsed URL must have exactly:

- protocol `postgres:` or `postgresql:`;
- hostname `127.0.0.1`;
- explicit port `5434`;
- database path `/vektor_preview`;
- no query string and no fragment.

### Rehearsal

The parsed URL must have exactly:

- protocol `postgres:` or `postgresql:`;
- hostname `127.0.0.1`;
- explicit port `5435`;
- database path `/preview_scenario`;
- no query string and no fragment.

The existing `assertDisposablePostgresUrl` contract in spec 0072 remains unchanged and continues
to reject port `5434`. The live target has a separate branded validation result. An unvalidated
string cannot be passed to the live composition root.

## Preflight

Live preflight is read-only and completes before backup or mutation. It requires:

1. the latest migration row to be `23_declarative-authorization-rules`;
2. the operator state marker `~/.local/state/vektor-preview/.seeded`;
3. both fixed bootstrap identities (`apex-preview-administrator` and `apex-preview-member`) in
   `person_profiles`, with `@example.invalid` contacts;
4. the global-administrator grant for `apex-preview-administrator`;
5. the canonical 0072 identity and named-prerequisite cohort already present, because live mode
   cannot create missing authority/configuration rows with raw SQL;
6. provider delivery disabled in the effective application configuration;
7. no production hostname or URL in accepted arguments or delivery variables.

Any missing or ambiguous fact fails closed. Preflight does not rotate credentials, invalidate
sessions, change grants, or run migrations.

The canonical 0072 program currently needs named rows for admission authority, payment authority,
and interview schema. Live mode reads and requires those rows. It never inserts them. Rehearsal may
prepare those rows through the existing disposable-only 0072 preparation path before it invokes the
exact shared application function. This preparation is not part of the live application path.

## Backup gate

Live mode creates a PostgreSQL custom-format snapshot before the first mutation:

- directory: `~/.local/state/vektor-preview/backups/`;
- file mode: `0600`;
- command: `pg_dump --format=custom` against the validated URL;
- name: timestamp, source-commit prefix, and random suffix; no URL or credential material;
- evidence: basename, SHA-256, byte length, and mode only.

The directory is operator-only. A failed process, missing file, empty file, wrong mode, or failed
hash prevents the application callback from running. Unit tests prove this ordering with injected
backup and application functions.

No automatic restore occurs after partial success. Native command receipts make retry the default
recovery. Restore is destructive and remains an explicit operator action.

## Shared 0072 application

Spec 0072 exposes a named scenario manifest and a named application function. The disposable CLI
continues to validate with `assertDisposablePostgresUrl`. The live composition imports the shared
function and manifest; it does not import or call the disposable CLI main.

The shared application:

- seeds identities only through `identity:seed` when the selected mode permits it;
- imports memberships through `Organization.importLegacyOrganization`;
- calls the real backend and Better Auth session boundary;
- creates departments and team through Organization administration HTTP;
- creates the admission period and application through native HTTP;
- assigns the interview through Recruitment HTTP;
- submits the receipt through multipart Receipt HTTP;
- creates and publishes the article through Content HTTP;
- reads back the assignment receipt, pending receipt, and published version;
- remains additive and command-receipt idempotent.

Live mode never runs the disposable prerequisite SQL. It preserves existing sessions, users, and
business records. It does not truncate, update unrelated rows, or choose caller-provided entity IDs.

## Evidence

The live composition writes sanitized JSON under
`~/.local/state/vektor-preview/evidence/` with mode `0600`. Rehearsal writes to a disposable
temporary directory. The evidence includes:

- spec ID `0076` and evidence format revision;
- mode and validated target tuple without userinfo;
- exact source Git HEAD and dirty-state refusal result;
- schema revision and preflight facts as booleans/counts;
- 0072 command-step statuses and command receipt identifiers;
- before/after counts and deterministic SHA-256 digests for scenario tables;
- replay result;
- backup basename, SHA-256, byte length, and mode;
- the rollback command template;
- explicit skips and remaining reconciliation risks.

Evidence never includes a database URL, URL userinfo, password, token, cookie, Better Auth secret,
provider endpoint, receipt file bytes, or raw personal/contact rows. Sanitization recursively rejects
sensitive key names and URL-like values before writing.

The rollback template is:

```sh
pg_restore --clean --if-exists --exit-on-error \
  --dbname="$VEKTOR_PREVIEW_SCENARIO_DATABASE_URL" \
  "$HOME/.local/state/vektor-preview/backups/<snapshot-basename>"
```

The operator must stop application writers and explicitly execute this command. This workstream does
not run it.

## Rehearsal

Rehearsal runs on `127.0.0.1:5435/preview_scenario`. It:

1. validates through the unchanged spec 0072 disposable guard;
2. prepares the disposable migration, identity, and named-prerequisite cohort;
3. invokes the same shared application callback used by live mode;
4. runs it a second time;
5. proves all command steps replay and counts/digests stay unchanged;
6. emits sanitized evidence and tears down the disposable PostgreSQL process.

No shared database, service, provider, or tunnel is required.

## Focused tests

Tests cover observable safety contracts:

1. live and rehearsal URL allowlists reject every other host, port, database, query, or fragment;
2. mode-specific target and acknowledgment are mandatory and exact;
3. a failed backup calls zero application commands;
4. a repeated shared application reports replay and stable counts/digests;
5. evidence sanitization rejects secrets and retains only the backup basename/hash metadata.

## Falsifiers

The implementation fails this spec if it:

- changes `assertDisposablePostgresUrl` to permit port `5434`;
- accepts a live URL from ambient environment or accepts URL query options;
- mutates before preflight and successful backup;
- writes a raw business-table insert in live mode;
- copies the 0072 scenario payloads into the live entrypoint;
- records secrets or raw contact data in evidence;
- automatically restores a snapshot;
- touches production, providers, DNS, services, credentials, or remote Git state.

## Acceptance

1. The spec is committed before implementation.
2. Focused tests, type checks, formatting, and lint pass.
3. A disposable PostgreSQL rehearsal executes the exact shared application twice and emits evidence
   with stable second-run counts/digests and replayed command steps.
4. The live invocation is documented but not executed.
5. The final worktree is clean and all changes are committed by pathspec.
