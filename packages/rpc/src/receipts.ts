/**
 * Receipts: submission, revision, approval, settlement, and receipt files.
 *
 * Its operations are listed in docs/specs/rpc-only.md; the HTTP contract they replace is
 * `packages/http-api/src/receipts.ts` and `receipt-upload.ts` at the base commit named there.
 *
 * @since 0.3.0
 */
import { RpcGroup } from "effect/unstable/rpc";

export class ReceiptsRpcs extends RpcGroup.make() {}

/** Internal receipt operations, served only on the internal ingress. */
export class InternalReceiptsRpcs extends RpcGroup.make() {}
