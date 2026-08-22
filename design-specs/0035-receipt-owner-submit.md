# Design spec 0035 — Receipt owner submission

> **Summary:** An authenticated active assistant submits one supported receipt file through the canonical SDK. The native Effect/PostgreSQL Receipt authority commits the Receipt, command receipt, audit row, and ordered outbox. The dashboard then reads the owner projection and shows the same stable Receipt as `Pending`. One real local browser journey crosses file bytes, HTTP, SDK, PostgreSQL, the private file adapter, and rendering without Symfony, provider, or production access.

## Metadata

| Field | Value |
|---|---|
| Goal | First complete native Receipt user journey |
| Status | Frozen and accepted for local implementation; no production cutover authority |
| Depends on | ADR 0004, ADR 0005, design specs 0033 and 0034 at `cdee3b5` |
| Actor | Authenticated, active assistant who owns the Receipt |
| Environment | Loopback HTTP, disposable PostgreSQL, disposable private filesystem root |

## User journey

1. The assistant opens **Mine Utlegg** with a valid authenticated session.
2. They select a PDF, PNG, or JPEG receipt of at most 10 MiB.
3. They enter a non-empty description of at most 5,000 characters, an exact positive NOK amount with at most two decimal places, and a real calendar date.
4. The dashboard sends a caller-generated stable `commandId` through the canonical Receipt SDK as multipart data. The wire amount is integer `amountOre`; floating-point money is forbidden.
5. The HTTP adapter derives actor identity, active state, department ownership, and the immutable payment-account snapshot from its authenticated actor service. It never accepts those authorities from the browser payload.
6. The private file adapter streams the bytes to a staging object, computes SHA-256 and byte length, and returns one immutable `ReceiptFile` identity. File bytes never enter SQL, responses, logs, or evidence.
7. `ReceiptAuthority` executes `SubmitReceipt` in one PostgreSQL transaction and returns a typed command observation. A replay with the same `commandId` and same canonical command digest returns the original observation without duplicate state, audit, or outbox rows. A different digest is rejected.
8. The staged object is promoted only through the committed ordered outbox request. Promotion failure is visible as pending processing and remains recoverable; it is never reported as a false durable success.
9. The dashboard refreshes the native owner projection and shows the same stable Receipt ID, description, exact NOK amount, receipt date, and `Pending` state.

## Canonical capability contract

The SDK Receipt capability is semantic, not CRUD:

- `submit(input, file) -> ReceiptCommandObservation`
- `listOwned(filter?) -> ReceiptPage`
- stable string `ReceiptId` and `CommandId`;
- positive safe integer `amountOre`, currency fixed to `NOK`;
- status vocabulary `Pending | Refunded | Rejected | Withdrawn`;
- immutable file identity `{ fileRef, objectKey, contentType, byteLength, sha256 }`;
- observation includes `commandId`, `receiptId`, `visualId`, `status`, `revision`, and `replayed`;
- typed rejections preserve `UnauthenticatedActor`, `InactiveActor`, `ReceiptOwnerDenied`, `ReceiptDecodeError`, `ReceiptAlreadyExists`, `DuplicateReceiptCommandConflict`, and `ReceiptPersistenceError` without exposing secrets or SQL.

The submission endpoint is `POST /api/receipts/submit`; the owner projection endpoint is `GET /api/receipts`. Existing update, delete, reopen, and generic status-setter semantics are outside this journey and MUST NOT be copied into the new capability. The untouched legacy SDK methods remain the authority for those not-yet-cut-over journeys until their own accepted specs replace them; they MUST NOT call the native endpoint.

## Local boundary configuration

All values are explicit at the composition root:

- loopback listen host and port;
- PostgreSQL URL;
- private staging and committed filesystem roots;
- maximum file bytes (`10_485_760` for this journey);
- token-to-actor mapping used by the local authenticated actor adapter;
- clock and stable ID generators.

The local actor token is test-only, scoped to loopback, and must not appear in evidence. No Cloudflare, Hyperdrive, R2, Symfony mutation, legacy database mutation, production data read, deployment, or route cutover is authorized.

## Accepted path

A valid submission produces exactly:

- one staged file and one committed file identity;
- one `economy_receipts` row in `Pending` revision 0;
- one command receipt;
- one audit row;
- ordered outbox requests with no duplicate effect identity;
- one owner projection row;
- one browser-visible `Pending` row with exact amount and date.

## Meaningful rejections

The browser journey must observe and the API must type at least:

- missing authentication;
- inactive actor;
- unsupported or missing file;
- file larger than 10 MiB;
- invalid calendar date;
- empty or overlong description;
- non-positive, fractional-øre, or unsafe amount;
- replayed `commandId` with different command bytes;
- durable PostgreSQL failure.

Rejected input creates no Receipt, command receipt, audit row, outbox row, or committed file. A staged file is removed or retained only as an explicitly evidenced recoverable staging artifact.

## Evidence and definition of done

One deterministic local runner starts disposable PostgreSQL, the private filesystem adapter, the native API, and the dashboard, then drives Chromium through the real form. It must attach or emit secret-free evidence containing:

- selected source revision and runner source references;
- request/response status and typed rejection tags without bearer token or business text;
- PostgreSQL counts and the accepted Receipt observation;
- staged/promoted file identity, digest, byte length, and lifecycle state without bytes;
- outbox delivery state and duplicate-effect count;
- rendered Receipt ID, exact amount, date, and `Pending` state;
- replay result proving no duplicate durable rows;
- cleanup result proving disposable database and filesystem removal.

The journey is falsified if it uses the loopback CRUD fixture as the Receipt authority, mocks PostgreSQL or file bytes, bypasses the canonical SDK, trusts browser-supplied actor/account authority, renders fixture data, leaks credentials or file bytes, leaves duplicate effects, or cannot clean up. Focused package checks and the repository root `check-types`, `lint`, `build`, and `test` must pass on the committed artifact, except unrelated pre-existing failures must be recorded with exact evidence.
