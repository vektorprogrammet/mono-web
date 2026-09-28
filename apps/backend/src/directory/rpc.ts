/**
 * The DirectoryRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/directory/http.ts, schools/http.ts, and schools/administration-http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { DirectoryRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const DirectoryRpcHandlers = (_options: NativeRpcOptions) => DirectoryRpcs.toLayer({});
