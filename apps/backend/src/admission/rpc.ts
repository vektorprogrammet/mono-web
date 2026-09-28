/**
 * The AdmissionsRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/admission/http*.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { AdmissionsRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const AdmissionsRpcHandlers = (_options: NativeRpcOptions) => AdmissionsRpcs.toLayer({});
