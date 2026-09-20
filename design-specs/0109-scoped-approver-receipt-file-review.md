# 0109 - Scoped approver receipt-file review

Status: frozen for local implementation, 2026-09-20. Production release unclaimed.

Baseline: `43a7d13f3aec09768004565b21426c7e2cf20842` (`migration/assistant-operations-0906`).

## Goal and product boundary

An authenticated native receipt approver can open the exact private receipt image or PDF from the approval queue before making a decision.

The read uses the current native `approveReceipt` capability and the existing `receipts.approver-relationship` rule. It adds no authority source and no finance policy. The file read does not change the receipt, write an audit row, create an outbox effect, or send a notification.

Legacy source:

- `apps/server/templates/receipt_admin/receipts_table_individual.html.twig` opens the receipt viewer from the administrator table.
- `apps/server/templates/widgets/receipt_viewer.html.twig` renders images and PDFs from `receipt.picturePath`.
- `apps/server/src/App/Operations/Controller/ReceiptController.php` supplies the administrator receipt surface.

The native approval queue already returns the scoped receipt metadata. The existing file endpoint is owner-only. It does not establish approver file access.

## Contract

1. Add `GET /api/receipt-approval-queue/:receiptId/file` as `receipts.readReceiptFileForApproval`.
2. Resolve the authenticated person, receipt row, Organization authority, direct receipt authority, applicable authorization rules, and approver relationship in one repeatable-read snapshot.
3. Use the same rule-aware approver relationship as the native approval queue. Do not authorize from a department identifier supplied by the caller.
4. Permit the read for every current queue status, including terminal receipts, while the approver relationship remains active.
5. Return `401` for a missing or invalid credential. Return no bytes when the receipt is absent, outside the caller's current scope, or the authority is inactive.
6. Read only the committed object selected by the authorized canonical receipt row. Never return `fileRef`, `objectKey`, a digest, or another storage identity.
7. Return the exact bytes with their canonical `image/jpeg`, `image/png`, or `application/pdf` media type. Set `Content-Length`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, and a safe inline filename.
8. Return a typed unavailable response if the authorized committed object cannot be read or fails the configured byte limit. Do not return partial bytes.
9. Add a same-origin dashboard resource route. The approval row opens it in a new tab as `Vis kvittering`. The dashboard route forwards the current session through the generated SDK and preserves the private response headers.
10. Keep the existing owner file endpoint owner-only. Share response construction where this prevents header drift, but do not widen owner access.
11. The generated OpenAPI, SDK operation inventory, reflected access metadata, and release artifacts remain derivations of the canonical HTTP contract.
12. A concurrent file read and refund, reject, or reopen decision creates no extra command, receipt mutation, audit row, or outbox effect.

## Acceptance

The disposable journey uses PostgreSQL, the native backend, generated SDK, dashboard server, real Chromium, and synthetic committed PNG and PDF bytes.

1. Seed two departments, an active scoped approver, an inactive or foreign person, receipt owners, and receipts in `Pending`, `Rejected`, and `Refunded` states.
2. Sign in as the scoped approver and load the native approval queue.
3. Open a PNG receipt from its row. Observe the exact synthetic bytes, `image/png`, private no-store headers, and no storage identity in the URL or response.
4. Open a PDF receipt and observe `application/pdf` with a safe inline filename.
5. Reload the queue and repeat a terminal receipt read while the same current relationship remains active.
6. Show that an owner can still use the owner endpoint and that owner access does not authorize the approver endpoint.
7. Show that the foreign or inactive person receives no private bytes. Show the absent and missing-object responses.
8. Read a file while a valid decision completes. Verify one lifecycle transition only and unchanged command, audit, and outbox counts beyond that decision.
9. Query PostgreSQL before and after file-only reads. Verify zero receipt, command, audit, and outbox writes from the reads.
10. Confirm desktop and mobile rendering, keyboard access, and no horizontal page overflow.
11. Record the exact executable revision, command, checksums, negative cases, unavailable boundaries, and cleanup result in `evidence/functional-parity/0109/acceptance-manifest.json`.

## Explicit non-goals

- No payment execution, account-number management, finance statistics, or production file migration.
- No new approver role, grant, department rule, or status transition.
- No public file URL, signed external URL, CDN, provider, or notification.
- No owner receipt-page redesign.
- No production data, credential, provider, remote push, deployment, or cutover.
