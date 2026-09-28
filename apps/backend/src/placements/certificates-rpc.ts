/**
 * The CertificatesRpcs handlers. The operations to port, and the HTTP handlers they replace
 * (`apps/backend/src/placements/certificates-http.ts` at the base commit), are listed in docs/specs/rpc-only.md.
 */
import { CertificatesRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";

export const CertificatesRpcHandlers = (_options: NativeRpcOptions) => CertificatesRpcs.toLayer({});
