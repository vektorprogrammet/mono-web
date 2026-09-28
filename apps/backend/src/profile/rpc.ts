/**
 * The ProfileRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/profile/http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { ProfileRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const ProfileRpcHandlers = (_options: NativeRpcOptions) => ProfileRpcs.toLayer({});
