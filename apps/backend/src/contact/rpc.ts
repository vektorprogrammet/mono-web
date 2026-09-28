/**
 * The ContactRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/contact/http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { ContactRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const ContactRpcHandlers = (_options: NativeRpcOptions) => ContactRpcs.toLayer({});
