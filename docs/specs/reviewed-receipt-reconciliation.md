# Reviewed receipt reconciliation

Status: frozen for local implementation and rehearsal. Production access and cutover remain unauthorized.

## Goal

An operator imports reviewed legacy expense claims through native receipt and private-file boundaries.
Every occurrence receives an accepted, quarantined, or excluded disposition. Acceptance requires retained private bytes and encrypted payment-account custody.

The command runs after committed Person and reference reconciliation. It does not pretend that SQL and files share one transaction.
The existing service cutover keeps its transaction boundary. Receipt selection and all source, target, archive, review, and key selections are explicit.

## Source and review

- Reuse the existing SELECT-only, consistent InnoDB snapshot reader. Receipt selection is explicit at every caller.
- Existing callers omit finance through an explicit selection. Their returned source shape and revisions remain unchanged.
- Selected finance includes receipt rows and separate account values. Passwords and account plaintext never enter ordinary source revisions or reports.
- Preserve raw receipt values for review. Read amounts as decimal text without floating-point rounding.
- Legacy receipts have no department column. The review supplies per-receipt department attribution through accepted reference provenance.
- Each receipt owner resolves through an accepted Person mapping in the named snapshot. Numeric source IDs and existing native People are insufficient.
- Bind the review to the source repository, source revision, watermark, snapshot identity, transformation, reviewer, and evidence reference.
- Require one review entry per occurrence. Missing, duplicate, unknown, or changed entries fail before target writes or staging.
- Accepted entries specify owner identity evidence, department evidence, normalized receipt and submission dates, and explicit approval time when applicable.
- Legacy refund dates can be stale or backfilled. Preserve their source digest without interpreting them as payment proof.
- Accepted entries bind the current source account with a keyed commitment and an explicit ownership evidence reference.
- Excluded entries carry a reason and evidence reference. They create no receipt, file, authority, or settlement.
- A review binds each private file to an archive-relative path, content type, byte length, and SHA-256 digest.

## Custody and persistence

Reuse the native receipt classifier, persistence importer, file store, and reconciliation behavior. Preserve the synthetic adapter's explicit restrictions.
Use a maintained cryptographic implementation from the runtime. Encrypt account values with authenticated encryption, fresh nonces, versioned key identity, and receipt-specific associated data.
Keep keys in an explicit owner-only file. Do not write account plaintext or an unkeyed account digest into evidence, SQL, logs, or review files.
An account commitment uses a separate derived key. Replays retain the original ciphertext rather than encrypting the account again.

The supported import boundary owns accepted Person/reference checks and immutable review provenance.
One transaction commits receipt facts and all cohort dispositions. Concurrent imports serialize their source ownership.
A source receipt cannot acquire a second target identity across snapshots. Changed accepted source content, review, or transformation fails without partial SQL writes.
Exact replay preserves later native edits, ciphertext, and prior dispositions. A replay must observe file custody again.
The persisted receipt ledger determines acceptance, including destination collisions. The command must not report classifier success after persistence quarantine.

File staging, promotion, and observation reuse the native file boundary. Archive traversal, outside symlinks, missing files, unsupported signatures, oversized files, and digest mismatches cannot produce accepted receipts.
A file failure affects its occurrence unless an infrastructure failure prevents a trustworthy cohort result.
Failed promotion remains explicitly pending and recoverable. No successful report claims reconciliation before committed bytes pass a fresh read.
Cleanup removes only resources that the command owns. A failed transaction must not delete a previously accepted file.
A restore or restart can resume incomplete file work from durable metadata and the authorized archive.

The import creates no submission grants, approval grants, settlement grants, human audit events, notification work, or payment transfers.
Legacy refunded claims map to native approval only through the reviewed timestamp. They never create settlement evidence.

## Operator command

The real command uses named environment variables for source and target connections and an explicit target database identity.
Reuse existing private JSON-file and transport checks. Reject insecure remote transport and malformed selections before connection.
Use the runtime database layer against an existing schema. Schema migration remains an explicit prior operation.
Output only counts, reasons, non-sensitive identifiers, source commitments, schema revision, and reconciliation state.
Errors retain safe stage/code information without credentials, raw SQL parameters, account plaintext, file paths, or source descriptions.

## Acceptance

Use real disposable MariaDB and PostgreSQL instances, the SELECT-only reader, actual CLI, actual cryptography, and real private file bytes.
The rehearsal proves:

- Pending, rejected, and reviewed refunded claims retain native meaning. No settlement or authority appears.
- Explicit owner and department evidence rejects wrong snapshots, same-label Person collisions, missing mappings, and unaccepted People.
- Every source occurrence is accounted for, including exclusions, malformed values, collisions, and missing files.
- Malformed review fails before target mutation. Invalid amounts, unsupported status, and invalid dates quarantine rather than invent data.
- File digests, sizes, signatures, traversal, outside symlinks, corruption, promotion failure, recovery, and fresh replay observations behave correctly.
- Account encryption decrypts with the correct key and context. Wrong keys, tampering, and wrong context fail. Plaintext never appears in retained evidence or database rows.
- First import, concurrent import, exact replay, replay after native edits, source conflict, target collision, and transaction rollback preserve ownership.
- Restart/restore and incomplete promotion retain private-byte custody without duplicate facts or effects.
- Existing synthetic receipt behavior and existing source-reader callers remain valid.

Record the tested source, commands, results, checksummed source archive, and evidence limits outside the product repository.
Actual historical import remains blocked by the missing file archive and unresolved ownership, department, account, and settlement evidence.
