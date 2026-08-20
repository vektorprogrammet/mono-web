# Design spec 0027 - accepted journey authority

## Metadata

| Field           | Value                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------- |
| Goal            | Author and consume one revision-bound accepted journey register                                   |
| Lifecycle state | Accepted for implementation                                                                       |
| Dependency      | 0024 real inventory contract and exact 0023 integration line                                      |
| Scope           | Accepted-intent input schema, deterministic authoring, external authority, and parity integration |

## Maintainer journey

A maintainer selects exact inventory rows for one accepted journey. The maintainer supplies the business assertion and source references.

The author command checks the input and calculates all derived values. It emits canonical JSON for a separate clean Git authority checkout.

The parity command pins that external commit and blob. It then links each selected row to the accepted journey steps.

## Goal

Make the accepted journey register usable without hand-calculated digests or undocumented object shapes.

The slice provides these outcomes:

1. A public JSON Schema defines the complete accepted-intent input contract.
2. One command checks an authoring document and emits canonical register bytes.
3. The command calculates record digests from canonical payloads.
4. The command sorts unordered reference sets with byte order.
5. The command rejects stale, missing, duplicate, unsafe, or unresolved references.
6. The parity runner checks canonical register bytes before it accepts the external authority.
7. A real external authority file covers at least one nonempty journey step.

## Authority boundary

The product owner supplies these assertions:

- the journey intent;
- the expected contract reference;
- the selected inventory rows;
- the coverage scope;
- each deliberate disposition.

The command must not infer or approve these assertions. It only checks structure and references.

The mono repository owns the schema, author command, and parity projections. A separate Git checkout owns `accepted-intent.json`.

The register must not exist in the mono projection directory. A projection must not become business authority.

## Input contract

The author command accepts one strict JSON object. Unknown object keys are invalid.

The document contains:

- `schema_version`;
- the exact legacy and mono revision references;
- coverage or disposition intents;
- accepted journeys;
- nonempty journey steps;
- exact row IDs or canonical signatures;
- source references;
- optional runtime evidence references.

The authoring input omits `intent_digest` and `journey_digest`. The command calculates these fields.

A logical client is a composition of capabilities. The register must not define a mutually exclusive user-role enumeration.

## Required behavior

### Accepted path

Given a valid authoring document and matching inventory artifacts, the command emits one canonical register.

A second run with the same inputs emits identical bytes. The existing parity decoder accepts those bytes.

The parity runner resolves each revision, source, row, intent, journey, and runtime evidence reference.

### Rejected paths

The command rejects these inputs without writing output:

- malformed or noncanonical JSON;
- unknown object keys;
- duplicate object members or duplicate IDs;
- a stale revision set;
- an unknown source, row, or runtime evidence reference;
- an empty journey or empty journey step;
- unsafe text, credentials, secrets, or personal data;
- a coverage intent without an owned journey;
- a disposition without an exact target;
- a digest supplied by the authoring input.

The parity loader rejects a register when its byte stream is not canonical JSON.

## Evidence

The authoring journey emits a receipt with:

- the input digest;
- the output digest;
- the selected revision references;
- the intent and journey counts;
- the covered row count;
- the output byte count;
- the rejection reason for a failed run.

The receipt contains no register content, credentials, or personal data.

## Falsifiers

The slice fails if one of these observations occurs:

- Two equal inputs emit different bytes.
- A maintainer must calculate a digest by hand.
- The schema accepts an object that the runtime shape rejects.
- The runtime accepts a noncanonical register byte stream.
- A stale or unresolved reference enters the register.
- An empty or synthetic-only step is presented as real journey coverage.
- The mono projection becomes the accepted-intent authority.
- A role label becomes the authority for a capability grant.

## Definition of done

1. `schemas/accepted-intent.json` defines the input register.
2. The runtime checks the schema before semantic checks.
3. The author command emits canonical bytes and a bounded receipt.
4. Unit tests cover one accepted document and each named rejection class.
5. One real nonempty journey register exists in a separate clean Git checkout.
6. The real parity runner pins that checkout and resolves the covered rows.
7. The package type, lint, build, and test checks pass.
8. The complete workspace checks pass.

## Evidence boundary

This slice proves authority structure and reference accounting for its selected rows. It does not prove that the user journey behaves correctly.

A later real browser journey supplies behavior evidence. Goal 1 still requires complete journey coverage and all named staging journeys.
