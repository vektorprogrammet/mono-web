/**
 * The TeamApplicationsRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/team-application/http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { TeamApplicationsRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const TeamApplicationsRpcHandlers = (_options: NativeRpcOptions) =>
  TeamApplicationsRpcs.toLayer({});
