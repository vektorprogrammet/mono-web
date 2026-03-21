import { Effect } from "effect"
import type { Transport } from "../transport.js"
import { LoginResponse } from "../schemas/user.js"
import type { InternalSdkError } from "../errors.js"

export interface AuthDomain {
  login(username: string, password: string): Effect.Effect<{ token: string }, InternalSdkError>
  resetPassword(email: string): Effect.Effect<void, InternalSdkError>
  setPassword(code: string, password: string): Effect.Effect<void, InternalSdkError>
}

export function createAuthDomain(transport: Transport): AuthDomain {
  return {
    login(username, password) {
      return transport.post("/api/login", { username, password }, LoginResponse)
    },
    resetPassword(email) {
      return transport.postVoid("/api/password_resets", { email })
    },
    setPassword(code, password) {
      return transport.postVoid(`/api/password_resets/${code}`, { password })
    },
  }
}
