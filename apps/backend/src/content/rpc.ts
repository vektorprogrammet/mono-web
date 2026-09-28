/**
 * The ContentRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/content/http*.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { ContentRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const ContentRpcHandlers = (_options: NativeRpcOptions) => ContentRpcs.toLayer({});
