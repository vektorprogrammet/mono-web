import { canonicalJson, canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";

/** Canonical JSON bytes used for command replay identity. */
export const admissionPeriodCommandBytes = (command: unknown): Uint8Array =>
  canonicalJsonBytes(command);

export const admissionPeriodCommandDigest = (command: unknown): string =>
  sha256Hex(admissionPeriodCommandBytes(command));

export { canonicalJson, canonicalJsonBytes, sha256Hex };
