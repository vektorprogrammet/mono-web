/**
 * The AdmissionOutcomesRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/admission/outcome-http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { AdmissionOutcomesRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const AdmissionOutcomesRpcHandlers = (_options: NativeRpcOptions) =>
  AdmissionOutcomesRpcs.toLayer({});
