/**
 * The OrganizationRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/organization/http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { OrganizationRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const OrganizationRpcHandlers = (_options: NativeRpcOptions) => OrganizationRpcs.toLayer({});
