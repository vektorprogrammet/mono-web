import { Effect, Schema } from "effect"
import type { Transport } from "../transport.js"
import type { InternalSdkError } from "../errors.js"

const LoginResult = Schema.Struct({ token: Schema.String })

export interface AuthDomain {
  login(username: string, password: string): Effect.Effect<{ token: string }, InternalSdkError>
  requestPasswordReset(email: string): Effect.Effect<void, InternalSdkError>
  resetPassword(code: string, password: string): Effect.Effect<void, InternalSdkError>
}

export function createAuthDomain(transport: Transport): AuthDomain {
  return {
    login(username, password) {
      return transport.post("/api/login", { username, password }, LoginResult)
    },
    requestPasswordReset(email) {
      return transport.postVoid("/api/password_resets", { email })
    },
    resetPassword(code, password) {
      return transport.postVoid(`/api/password_resets/${code}`, { password })
    },
  }
}
