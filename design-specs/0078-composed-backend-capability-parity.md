# Design spec 0078 — composed backend capability parity

> **Summary:** Compare versioned user intents through finite backend composition witnesses. OpenAPI supplies only the atomic operation vocabulary. Claim-specific runtime evidence supplies behavioral warrants.

## Metadata

| Field | Value |
| --- | --- |
| Goal | Compare legacy Symfony and native Effect backend capabilities without route-count parity |
| Contract | `backend-atomic-operation-catalog/v1`, `functional-parity-accepted-intent/v2`, `functional-parity-capability-runtime-evidence/v2`, `functional-parity-capability-report/v1` |
| Specification state | Frozen for implementation on `2026-08-31` |
| Base worktree | `/tmp/mono-web-httpapi-contract` |
| Base revision | `bf64dd639ae26f35db7d14210effd7a9e6192fe5` |
| Implementation worktree | `/tmp/mono-web-composed-api-parity` |
| Implementation branch | `feat/0078-composed-api-parity` |
| Package owner | Existing `packages/parity-inventory` package |
| External effects | None |

The implementation does not deploy software. It does not call a provider or use a shared database. It does not change external authority files.

## Authority pins

The command receives all authority paths as arguments. It has no ambient authority fallback.

| Authority | Git revision | Blob object | SHA-256 of exact bytes |
| --- | --- | --- | --- |
| Accepted intent v1 input | `04664df925304c3cbfe01c938bc464cc0c1ceb2d` | `20dfac097b75c44a9069dda33349589fa4523f5b` | `sha256:2faf191a6e66ddc34c574a71d5fde314bce4194c1073ba932ef9fc19c6f9af7a` |
| Runtime evidence v1 input | `48ba72ee55e4eac3c88fbdc63606e6812ff71b30` | `6e3d9512bf3410297d562f2eefa4755e04c0fd3f` | `sha256:573c83e53417b3410c843c9858f7697352308c6e8ab1938395c112efd5e07378` |

The runtime repeats each Git revision, blob, canonical-byte, and digest check. A mismatch stops the comparison.

## Semantic boundary

The comparison receives these inputs:

- two OpenAPI 3.1 documents;
- one accepted-intent authority register;
- one runtime-evidence authority register;
- explicit repository source roots;
- one explicit output directory;
- one explicit mode.

The comparison emits these projections:

- one atomic operation catalog for each backend;
- one canonical capability parity report;
- one report sidecar receipt;
- one migration candidate when the operator supplies a migration output path.

The command treats accepted intent as a human assertion. It treats OpenAPI and source metadata as declarations. It treats receipt claims as observations.

## Comparison law

The unit of comparison is a versioned user intent and its finite composition witness. A route, path, tag, or operation total is not a comparison unit.

Different operation graphs can satisfy the same intent. Equal route sets can fail to satisfy the same intent.

The report contains no route-count metric. It contains no operation-count metric. It contains no percentage or count-derived verdict.

The report verdict is `equivalent` only when both backend witnesses satisfy all required semantic items:

- accepted assertions;
- required rejections;
- required side effects;
- freshness requirements;
- precondition implications;
- finite graph termination.

Each required item needs a non-stale backend-specific v2 claim. A passing receipt without a named claim satisfies no semantic item.

The verdict is `not_equivalent` when current evidence establishes a semantic mismatch. The verdict is `unknown` when a required fact lacks authority or evidence.

## OpenAPI evidence limit

OpenAPI defines atomic operation vocabulary and declared transport contracts. It can establish these facts:

- an operation identifier exists;
- a method and path template exist;
- a request or response schema declaration exists;
- a security requirement declaration exists;
- an application extension declaration exists.

OpenAPI cannot establish these facts:

- a write persisted;
- an authorization rule executed;
- an effect reached a provider;
- a transaction committed or rolled back;
- a later read returned fresh data;
- a response preserved privacy.

The extractor emits `unknown` or `unsupported` for each unsupported fact. It never infers a behavioral claim from a route, status code, security scheme, or extension.

## Atomic operation catalog

The catalog schema is strict JSON Schema 2020-12. Every object sets `additionalProperties: false`.

Each catalog contains:

- `schema_version`;
- `backend`;
- OpenAPI byte and canonical digests;
- generator and source revision references;
- sorted operation records;
- sorted diagnostics.

Each operation record contains:

- `operation_ref_id` with the backend and exact `operationId`;
- `operation_id`;
- method and path template;
- effective declared security;
- canonical request inputs;
- canonical response contracts;
- source-declared effects;
- source metadata;
- OpenAPI and canonical operation digests;
- JSON Pointer and source references.

The extractor rejects a duplicate or missing `operationId`. It reports the exact method and path for the rejected operation.

### Security rules

An operation-level `security` value overrides the root value. An absent operation value inherits the root value.

The security array is an OR expression. Scheme keys in one security object form an AND expression.

An empty array declares no security requirement. An array that contains an empty object permits anonymous access.

The extractor preserves the exact schemes and scopes. It does not translate a role label into a capability.

### Schema canonicalization

The extractor resolves internal JSON Pointer references. It rejects an external reference.

The canonicalizer detects reference cycles. It uses a stable reference marker for a valid recursive schema.

The canonicalizer sorts object keys by UTF-8 byte order. It preserves array order unless the contract defines the array as a set.

Each request, response, and header schema gets a canonical digest. An unresolved schema gets a null digest and an exact diagnostic.

## Legacy Symfony generation

The repository command regenerates `packages/sdk/legacy-symfony-openapi.snapshot.json` from real API Platform metadata. The snapshot is never edited by hand.

The metadata collector adds these source-derived fields:

- stable operation identity;
- operation and post-denormalization security;
- status;
- input and output classes;
- provider and processor;
- read, deserialize, validate, and output flags;
- validation groups;
- exact source references;
- `x-vektorprogrammet-operation`.

The reconciler maps metadata to OpenAPI by normalized method, `/api`-prefixed URI template, resource class, and operation identity. Zero or multiple candidates fail closed.

A source and OpenAPI security disagreement fails closed with `SECURITY_METADATA_CONFLICT`. The reconciler never selects one declaration silently.

The generated legacy contract contains 128 atomic operations at the frozen source revision. This number records an input fact only. It is not a parity measure.

## Native Effect extraction

The native extractor consumes `packages/http-api/openapi.json`. It retains group-qualified identifiers such as `admissions.submitApplication`.

The frozen native document contains 47 public atomic operations. The extractor does not change this surface.

The extractor reads source provenance and `x-vektorprogrammet-operation` when present. A missing semantic declaration produces `declared_subset` or `unknown` effect completeness.

The extractor does not build a route-to-intent table. Intent authority binds atomic operations to witness nodes.

## Accepted intent v2

The v2 schema is a strict JSON Schema 2020-12 contract. It contains these registers:

- source authority pins;
- finite predicate definitions;
- finite projection and transform definitions;
- versioned intent compositions;
- backend implementation witnesses;
- migration diagnostics.

Each intent contains:

- exact intent reference, revision, and digest;
- source references;
- semantic command, query, and observation stages;
- required preconditions;
- warranted outcomes;
- side effects and cardinality;
- rejection semantics;
- freshness requirements;
- backend implementation witnesses.

Each implementation witness contains finite nodes and typed edges. The edge kinds are `data`, `authority`, and `order`.

Each data edge names finite selectors and one registered transform. Each authority edge names one registered precondition.

Each order edge names `must_precede` or `read_after_write`. The order projection must be a directed acyclic graph.

Every witness declares the semantic item IDs that it satisfies. A graph edge or node does not imply satisfaction by itself.

### Predicate and projection registers

A predicate definition has a finite identifier and sorted implication references. The implication graph must be acyclic.

A witness precondition is sufficient only when its predicate equals or implies the required predicate. The comparator does not infer logical implication from names.

A projection or transform definition has finite input and output selectors. It has exact source references.

Two schemas are compatible only through an exact digest or a registered source-linked projection. A similar shape produces `unknown`.

## V1 to v2 candidate migration

The migration is deterministic. It retains each existing v1 intent, journey, step, selected row, source reference, and receipt reference.

The migration does not add semantic meaning to a v1 row. Each missing semantic assertion creates an explicit diagnostic.

The required missing-assertion classes are:

- preconditions;
- warranted outcomes;
- rejections;
- side effects;
- freshness;
- witness graph bindings;
- claim-specific runtime evidence.

A migrated v1 receipt becomes `journey_executed` only. It does not become a v2 behavioral claim.

The candidate never replaces the authority file. The command writes it only to an explicit `/tmp` path or a committed generated fixture path.

## Capability runtime evidence v2

The v2 evidence schema is strict JSON Schema 2020-12. Each receipt binds these values:

- backend;
- intent reference and revision;
- implementation digest;
- backend source revision;
- OpenAPI digest;
- operation digests;
- runner and fixture digests;
- sanitized artifact digest and pointer;
- result;
- sorted semantic claims.

A claim has one kind:

- `journey_executed`;
- `operation_observed`;
- `boundary_observation`;
- `rejection_observed`;
- `persistence_observed`;
- `effect_requested`;
- `effect_delivered`;
- `transaction_rollback_observed`;
- `fresh_read_observed`.

Each claim names exact witness, node, assertion, effect, rejection, or freshness identifiers. A claim cannot use an identifier outside its implementation witness.

The validator rejects a receipt with stale source, implementation, OpenAPI, or operation digests. It rejects one claim that uses the wrong backend.

## Graph validation

The graph validator applies these rules:

1. Every node, edge, semantic stage, predicate, projection, operation, and evidence reference resolves exactly once.
2. Node IDs and edge IDs are unique in their complete scopes.
3. Every operation node binds the exact operation digest from its backend catalog.
4. Every data edge has valid source and target selectors.
5. Every authority edge references one required precondition.
6. Every order edge connects existing nodes.
7. The order projection is acyclic.
8. Every accepted witness has a bounded terminal observation.
9. Every declared satisfaction ID exists in the intent.
10. Unsupported declarations remain unsupported.

A data or authority feedback relation cannot enter the schedulable order projection. The contract contains no implicit retry or unbounded traversal.

## Comparator

The comparator processes one accepted intent at a time. It computes one implementation result for each backend.

An implementation result contains:

- `claim` as `supported`, `unsupported`, or `unknown`;
- a canonical witness digest or null;
- evidence status;
- sorted diagnostics;
- exact missing claim kinds.

The comparator checks semantic coverage before it checks evidence. It then checks claim scope and freshness.

A backend cannot receive `supported` when one required semantic item lacks a graph binding. It cannot receive `supported` when one required claim lacks current evidence.

The row verdict rules are:

| Legacy result | Native result | Semantic comparison | Verdict |
| --- | --- | --- | --- |
| `supported` | `supported` | All assertions, rejections, effects, and freshness match | `equivalent` |
| current warranted result | current warranted result | At least one required item differs | `not_equivalent` |
| any other case | any other case | A required fact lacks authority or evidence | `unknown` |

A large catalog has no advantage. A small complete composition can satisfy an intent that a larger incomplete catalog cannot satisfy.

## Tracer rows

The canonical report selects these bounded tracer rows. Selection is not business authority.

### Public application

The source intent is `intent://journey:parity:applicant_admission:v1`. The comparator retains its current source and evidence references.

The witness must cover application input, accepted transition, privacy-safe confirmation, duplicate rejection, persistence, effects, and fresh confirmation.

Current v1 receipts have no claim-specific persistence, effect, rejection, privacy, or freshness evidence. The generated verdict is `unknown`.

### Interview scheduling and invitation acceptance

The source intent is `intent://journey:recruitment:interview-scheduling:v1`. The witness can use different authority and operation graphs on each backend.

The witness must cover scheduling, invitation response, rejection privacy, side effects, and fresh reads. Current v1 receipts do not warrant these claim kinds.

The generated verdict is `unknown`.

### Receipt owner and scoped approval

This row composes `intent://journey:parity:receipt_self:v1` and `intent://journey:parity:finance_operations:v1`.

The external v1 register does not contain a reviewed composed capability intent. The report keeps both component refs and emits `MISSING_SEMANTIC_ASSERTION`.

The witness must cover owner submission, owner read, scoped approval, pending-state checks, revision checks, audit or outbox effects, and fresh reads.

The generated verdict is `unknown` until the external v2 authority defines the composition and v2 receipts warrant its claims.

### Applicant assignment negative control

The source intent is `intent://journey:recruitment:applicant-assignment:v1`. A v1 passed receipt does not become v2 evidence.

The report emits `RECEIPT_STALE` and the missing claim classes. The generated verdict stays `unknown`.

## Deterministic report

The command writes these generated files under `evidence/capability-parity/`:

```text
atomic-legacy.json
atomic-native.json
capability-parity-report.json
capability-parity-report.receipt.json
```

The report contains:

- schema version;
- canonical input provenance and hashes;
- sorted comparison rows;
- sorted global diagnostics;
- canonicalization rule identifier.

The report contains no self-hash. The sidecar receipt contains the exact report byte digest and every generated artifact digest.

The report JSON uses recursive key sorting and contract-specific array sorting. It uses compact UTF-8 JSON without a terminal newline.

`--mode write` performs atomic replacement after complete validation. `--mode check` regenerates in an isolated directory and compares exact bytes.

The check mode does not write the committed report directory. A stale or missing file makes the command fail.

## Command

The root command is:

```sh
bun run capability-parity:verify -- \
  --legacy-openapi packages/sdk/legacy-symfony-openapi.snapshot.json \
  --native-openapi packages/http-api/openapi.json \
  --intent-register /srv/share/projects/vektorprogrammet/functional-parity-intent-authority/accepted-intent.json \
  --evidence-register /srv/share/projects/vektorprogrammet/functional-parity-runtime-evidence/runtime-evidence.json \
  --output evidence/capability-parity \
  --mode check
```

The CLI requires every path and `--mode`. It rejects an unknown option, a duplicate option, and an omitted path.

## Required tests

The focused test suite covers these cases:

- security inheritance;
- security OR, AND, and optional semantics;
- canonical internal `$ref` resolution;
- duplicate and missing operation IDs;
- ambiguous legacy metadata mapping;
- source and OpenAPI security conflict;
- graph cycles and dangling edges;
- finite predicate and projection references;
- different graph shapes with equal explicit semantics;
- equal routes with one missing outcome;
- missing effect claims;
- missing freshness claims;
- stale v1 receipts;
- deterministic replay;
- a large incomplete catalog against a small complete composition.

Each behavioral test checks an observable contract. No test treats a route count as a parity metric.

## Verification sequence

Run these commands in order:

1. Run the real Symfony `api:spec` generator.
2. Run `bun run --cwd packages/http-api generate:check`.
3. Run package type checks.
4. Run package lint.
5. Run package tests.
6. Run the root parity command.
7. Run the capability command in check mode.
8. Run the root format check.
9. Run the root check.
10. Run the root lint command.
11. Run the root build command.
12. Run the root test command.

## Evidence limits

The atomic catalogs prove only normalized declarations and source provenance. The report proves only the deterministic comparison of supplied authority and evidence.

An `unknown` verdict is a correct result when authority or evidence is incomplete. The implementation never changes `unknown` to `equivalent` to make a gate pass.
