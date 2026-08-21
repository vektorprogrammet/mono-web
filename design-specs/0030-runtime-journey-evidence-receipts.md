# Goal-1 design spec 0030 - runtime journey evidence receipts

> **Summary:** A maintainer runs a named browser journey at an exact source revision. The runner emits a sanitized receipt. The parity inventory links accepted journey steps to that receipt and rejects stale or failed evidence.

## Metadata

| Field | Value |
|---|---|
| Goal | Goal-1 journey evidence authority |
| Lifecycle state | Frozen |
| Dependency | 0024 zero-gap inventory and 0027 accepted journey authority |
| Authority | A separate clean Git repository or clean Git worktree |
| Consumer | `packages/parity-inventory` |

## Maintainer journey

1. The maintainer selects one accepted journey.
2. The maintainer runs its real browser gate against a disposable database.
3. The runner records the exact source revisions and deterministic input digests.
4. The runner emits canonical receipt bytes after the run stops.
5. The maintainer commits only the canonical receipt file to the evidence authority.
6. The parity command reads the clean evidence authority.
7. The inventory links each covered step to one successful receipt.
8. The inventory rejects a stale, failed, malformed, unsafe, or unrelated receipt.

## Receipt contract

Each receipt contains these fields:

| Field | Rule |
|---|---|
| `receipt_ref_id` | A content-derived stable reference |
| `journey_ref_id` | One accepted journey reference |
| `step_ids` | One or more exact step identifiers from that journey |
| `legacy_revision_ref_id` | The selected legacy revision |
| `mono_revision_ref_id` | The exact tested mono revision |
| `runner_source_ref_ids` | Source references for the browser runner and specification |
| `runner_digest` | The digest of the executed runner inputs |
| `fixture_digest` | The digest of the deterministic database fixture inputs |
| `environment_kind` | A closed non-production environment value |
| `exit_code` | `0` for accepted evidence |
| `result` | `passed` or `failed` |
| `artifact_digest` | The digest of the sanitized execution artifact |

The canonical receipt excludes timestamps, local paths, credentials, tokens, database contents, and browser output text.

## Constraints

- The accepted-intent repository remains the only business-intent authority.
- The evidence repository remains the only browser-run evidence authority.
- A receipt cannot create or change an accepted journey.
- The runner generates the receipt. A maintainer does not hand-author runtime claims.
- The receipt uses strict schema decoding and canonical JSON.
- The parity command pins the evidence authority revision and file digest.
- The source roots, intent authority, evidence authority, and projection directory cannot overlap.
- A receipt must select the same source revisions as its accepted journey.
- A receipt must name only steps from its accepted journey.
- Failed runs remain visible but cannot satisfy journey coverage.
- One successful receipt can cover multiple steps from the same executed journey.
- Fixture mode cannot consume production evidence receipts.
- The write gate remains blocked if a required user-visible step has no accepted receipt.

## Definition of done

The slice is complete when all these statements are true:

- A public JSON Schema defines the receipt register.
- The CLI accepts an explicit evidence-register path for `diff` and `write` modes.
- The source manifest records the evidence authority revision, digest, and source references.
- The assignment runner emits one canonical receipt for its exact revision.
- The scheduling runner emits one canonical receipt for its exact revision.
- Accepted journey steps link to the correct receipt references.
- A second run with the same deterministic inputs emits identical receipt bytes.
- A stale source revision fails closed.
- An unknown journey or step fails closed.
- A failed browser result does not satisfy coverage.
- Unsafe scalar content fails before the inventory hashes or publishes it.
- Package type checks and focused tests pass.
- Both real browser journeys pass and produce accepted receipts.

## Falsifiers

The slice is not complete if one of these conditions occurs:

- A test source file counts as evidence that its browser journey ran.
- An unavailable collector observation counts as browser evidence.
- A maintainer can change a receipt without changing its digest or reference.
- A receipt from another source revision satisfies the current inventory.
- One journey receipt covers a step from another journey.
- A failed run produces accepted coverage.
- Receipt bytes contain a credential, token, local path, timestamp, or database row.
- The parity projection becomes a second source of receipt authority.
