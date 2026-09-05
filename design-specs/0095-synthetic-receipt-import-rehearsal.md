# 0095 — Synthetic legacy receipt import rehearsal

Status: frozen for local implementation. Parent: `694cc34f0cd7b9def78b2d9c988a6998d849d4f4`. Independent of 0094 substitute-pool semantics.

## Goal

An operator runs one documented local command against owned disposable resources. An immutable synthetic legacy-shaped receipt cohort and file inventory are mapped to explicit native Person/Department identities, imported using the existing Receipt transformation/store, and reconciled against fresh native reads and actual private bytes. The mapped owner signs in through the native credential boundary and reads the imported receipts/files through the real native HTTP/SDK boundary. A different owner cannot read those files. Replay, quarantine and restore are observable. Every source occurrence has an accounted-for outcome.

This is an executable developer/operator migration capability, not a production importer rollout or password migration. No production/private data, external provider, deployment, remote action or live database is authorized. The source snapshot, accounts and payment placeholders are explicitly synthetic. No changes to substitute, placement, applicant onboarding, password recovery, notification delivery, receipt reopening or legacy writer routing belong here.

## Roots and reuse

- Existing contract: `design-specs/0033-receipt-authority-capsule.md`, especially import, reconciliation and cutover boundaries. Existing receipt source is authoritative when older migration prose disagrees; do not rewrite its lifecycle rules in this rehearsal.
- `packages/domain/src/receipt/import.ts` owns amount/status/file validation, occurrence identity and accepted/quarantined transformation. `storeReceiptImportResult` in `receipt/postgres.ts` owns transactional fact/ledger insertion and replay protection. Extend at these seams when needed; do not build a second receipt importer or ledger.
- `apps/backend/src/receipt/filesystem.ts` and file services already stage/promote/delete private bytes. Native login fixtures, SDK contracts and disposable PostgreSQL lifecycle tooling are reusable. Recording file/effect Layers are not sufficient acceptance evidence.
- The prior consolidation proved a native receipt submission with a file and replay. It did not import legacy accounts/receipts/files, reconcile imports, deliver receipt notifications, fence legacy writes or restore production.

### Explicit implementation amendment — missing private read boundary

Source tracing after freeze established that the native Receipt API has no private-file download operation and the existing filesystem service has no committed-byte read operation. The original assumption that those endpoints could be reused was incorrect. To complete this same owner-read journey, add a narrow owner-only native receipt-file read operation and a verified committed-byte reader using the existing storage identity and receipt authorization models. The API/SDK/OpenAPI/access metadata must derive from the canonical endpoint. Authenticate and authorize the persisted receipt owner before storage access, reject missing or altered bytes, use private/no-store responses and safe attachment headers, and never expose the raw storage key. Verify owner, foreign-owner and anonymous requests against real HTTP and actual bytes. This amendment does not add approver downloads, a new receipt UI, storage signing infrastructure or production rollout.

## Contract and invariants

1. Input is a runtime-decoded immutable synthetic snapshot manifest with source repository/revision, snapshot ID, watermark, row occurrence identities, row/file digests, explicit source User→Person and Department associations, and a bounded source-file root. Names/email equality cannot infer identity. Fixture accounts have explicit disposable provenance and verified expected association; administrative seed `skipped` is not enough to accept a mismatched account.
2. Use exact decimal-to-øre transformation and current canonical Receipt models. Preserve source visual IDs, status, dates and refund dates. Count all source occurrences, including malformed/unresolved ones; accepted plus quarantined equals the input occurrence count. Every quarantine has a reason and provenance. Do not replace unknown facts with fabricated defaults or invent money transfer evidence.
3. Actual file bytes must be opened from the authorized fixture root, checked against manifest digest/size/type and copied/staged through the existing private storage boundary. Reject traversal, outside-root links, missing/unreadable bytes, digest mismatch, unsupported type and conflicting file identities. Never expose raw object keys, payment material or login credentials in public projections or evidence.
4. Accepted fact and import ledger remain atomic and idempotent. Exact replay leaves receipt facts, ledger and committed file bytes unchanged; changed provenance under the same occurrence identity rejects. Destination collisions quarantine according to existing ownership semantics. Concurrent/interrupted attempts cannot claim reconciliation for a missing or foreign file. Reuse transaction/locking primitives; do not create a second command-receipt system.
5. Reconciliation is a fresh observation of authoritative persisted facts, native owner projection and actual bytes, associated with the exact source occurrence/digest. Add a narrow guarded completion path to the existing reconciliation ledger if required. A pending import is not reconciled merely because insertion returned successfully. Changed facts/bytes after a prior reconciliation must not be silently reported as still current.
6. Historical import emits zero receipt notification attempts and no user-command outbox effects. Assert this at the actual effect boundary as well as database tables; successful process-local recording is not delivery. Do not wire real providers to obtain this evidence.
7. Failure between private-file staging and import commit is explicitly exercised; retry converges without a visible reconciled orphan. Cleanup only removes objects this import attempt owns and that no committed receipt references. State/effect ordering and retry ownership must be documented; do not claim a distributed transaction between filesystem and PostgreSQL.
8. Restore uses an actual owned pre-import DB snapshot and file inventory into an owned disposable destination, then compares canonical baseline facts/bytes and credentials needed by the fixture. Transaction rollback or merely stopping PostgreSQL is not restore evidence. Do not overwrite unknown native writes or suggest this is a production rollback procedure.

## Acceptance

Run on a clean committed artifact with real PostgreSQL, native backend/auth/HTTP, SDK and filesystem; all hosts/resources are local and owned. A browser is not required for this operator CLI/HTTP import contract unless an existing frontend changes. The native owner read and private-file download must cross the real authenticated HTTP boundary.

- A cohort includes valid Pending, Refunded and Rejected records, preserving exact amounts/visual IDs/timestamps/refund dates; invalid amount/date/status, missing mappings, missing file, mismatched file digest, duplicate/colliding identities and traversal produce explicit rejected/quarantined outcomes with complete occurrence accounting.
- Owner signs in and reads imported receipts and original bytes through native SDK/HTTP; another owner and an unauthenticated caller are denied the private files. Imported history does not grant new economy or Organization authority.
- Fresh reconciliation verifies each accepted row/byte association, not just global counts. Tampering with a copied file or relevant native fact invalidates the fresh reconciliation observation. Restoring the fixture's correct state permits a new warranted observation.
- Exact replay, conflicting replay and failure/retry around file staging/ledger commit are observed. Native receipt, ledger and file snapshots demonstrate required stability. Imported historical rows produce zero notification attempts.
- Actual restore to the owned baseline is followed by fresh comparison. Evidence records source SHA, source manifest digest, accepted/quarantined counts/reasons, per-occurrence reconciliation, denial cases, effect counts, replay comparison, restore comparison and confirmed process/database cleanup.
- Appropriate domain/database/backend tests, types, formatting/lint and generated docs/checks pass. No skipped dependency is reported as a passed boundary. Prefer existing commands and compatible dependencies; do not introduce Python project source or new infrastructure frameworks.

## Delivery and ownership

One exclusive engineer worktree owns this contract. Root integrates/reviews separately; 0094 may proceed in another worktree. Shared schema registry/generated contracts can conflict at integration and must be resolved explicitly. One heavy job across the project; obtain the coordinator's token before PostgreSQL/browser/large builds and release after observed cleanup.

Deliver a documented command, clean local commits, durable exact-source evidence and a concise limitation statement. Do not push, open a remote PR, merge remotely, deploy, access real credentials, mutate production or enable providers. Remove only owned disposable resources after evidence is preserved; keep source work until integration is verified.
