import { Effect } from "effect";
import type { Transport } from "../transport.js";
import type { InternalSdkError } from "../errors.js";

export interface AuthDomain {
  resetPassword(email: string): Effect.Effect<void, InternalSdkError>;
  setPassword(code: string, password: string): Effect.Effect<void, InternalSdkError>;
}

export function createAuthDomain(transport: Transport): AuthDomain {
  return {
    resetPassword(email) {
      return transport.postVoid("/api/password_resets", { email });
    },
    setPassword(code, password) {
      return transport.postVoid(`/api/password_resets/${code}`, { password });
    },
  };
}
