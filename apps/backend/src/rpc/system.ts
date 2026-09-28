/**
 * The SystemRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/http-api/system.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { SystemRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "./options.js";

export const SystemRpcHandlers = (_options: NativeRpcOptions) => SystemRpcs.toLayer({});
