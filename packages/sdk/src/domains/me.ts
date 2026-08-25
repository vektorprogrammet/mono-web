import { Effect, Schema } from "effect"
import type { Transport } from "../transport.js"
import { Validation, type InternalSdkError } from "../errors.js"
import { SessionActor, UpdateOwnProfileCommand, UserProfile } from "../schemas/user.js"
import { DashboardStats } from "../schemas/dashboard.js"

export interface MeDomain {
  session(): Effect.Effect<SessionActor, InternalSdkError>
  profile(): Effect.Effect<UserProfile, InternalSdkError>
  dashboard(): Effect.Effect<DashboardStats, InternalSdkError>
  updateProfile(
    command: UpdateOwnProfileCommand,
  ): Effect.Effect<UserProfile, InternalSdkError>
}

const strictProfile = {
  strict: true,
  errorFamily: "profile",
  decodeError: () =>
    new Validation({ message: "Invalid profile representation", fields: {} }),
  expectedStatus: 200,
  headers: { Accept: "application/json" },
} as const

const strictSession = {
  strict: true,
  decodeError: () =>
    new Validation({ message: "Invalid session actor representation", fields: {} }),
  expectedStatus: 200,
  headers: { Accept: "application/json" },
} as const

const decodeProfileCommand = (
  command: unknown,
): Effect.Effect<UpdateOwnProfileCommand, Validation> =>
  Schema.decodeUnknownEffect(UpdateOwnProfileCommand)(command, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      () => new Validation({ message: "Invalid profile representation", fields: {} }),
    ),
  )

export function createMeDomain(transport: Transport): MeDomain {
  return {
    session() {
      return transport.get("/api/me/session", SessionActor, undefined, strictSession)
    },
    profile() {
      return transport.get("/api/me", UserProfile, undefined, strictProfile)
    },
    dashboard() {
      return transport.get("/api/me/dashboard", DashboardStats)
    },
    updateProfile(command) {
      return decodeProfileCommand(command).pipe(
        Effect.flatMap((validCommand) =>
          transport.put("/api/me", validCommand, UserProfile, strictProfile),
        ),
      )
    },
  }
}
