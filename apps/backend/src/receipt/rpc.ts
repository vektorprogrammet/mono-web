/**
 * The ReceiptsRpcs and InternalReceiptsRpcs handlers. The operations to port, and the HTTP
 * handlers they replace (`apps/backend/src/receipt/http*.ts` at the base commit), are listed in
 * docs/specs/rpc-only.md.
 */
import { InternalReceiptsRpcs, ReceiptsRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const ReceiptsRpcHandlers = (_options: NativeRpcOptions) => ReceiptsRpcs.toLayer({});

export const InternalReceiptsRpcHandlers = (_options: NativeRpcOptions) =>
  InternalReceiptsRpcs.toLayer({});
