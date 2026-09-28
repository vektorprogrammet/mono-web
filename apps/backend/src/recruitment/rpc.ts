/**
 * The RecruitmentRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/recruitment/http*.ts and recruitment/maintenance-http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { RecruitmentRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const RecruitmentRpcHandlers = (_options: NativeRpcOptions) => RecruitmentRpcs.toLayer({});
