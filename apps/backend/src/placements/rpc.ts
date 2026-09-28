/**
 * The PlacementsRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/placements/http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { PlacementsRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const PlacementsRpcHandlers = (_options: NativeRpcOptions) => PlacementsRpcs.toLayer({});
