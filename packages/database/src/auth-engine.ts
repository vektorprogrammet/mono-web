import { betterAuth } from "better-auth"
import { Pool } from "pg"

/**
 * AuthLive engine wiring (spec 0054).
 *
 * The better-auth instance is the session/credential ENGINE behind the
 * `Auth` Service. It depends on the vektorprogrammet PostgreSQL via a plain
 * pg Pool pointed at the same authoritative database; its tables live in the
 * dedicated `auth` schema so domain tables in `public` stay untouched.
 * Roles and access policy are NEVER read here - this module resolves
 * "which person is this session" and nothing more.
 */
export interface AuthEngineConfig {
  /** Same connection string as BACKEND_PG_URL; auth schema via search_path. */
  readonly postgresUrl: string
  readonly secret: string
  readonly baseURL: string
}

export const makeAuthPool = (config: AuthEngineConfig) =>
  new Pool({
    connectionString: config.postgresUrl,
    options: "-c search_path=auth",
    max: 4,
    application_name: "vektorprogrammet-auth",
  })

export const makeAuthEngine = (
  config: AuthEngineConfig,
  database: Pool = makeAuthPool(config),
) =>
  betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    database,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    advanced: {
      database: {
        // Session rows join user rows server-side; keep default for now.
        joins: false,
      },
    },
    user: {
      // auth.user.id IS PersonId - set explicitly at seed/creation time.
      modelName: "user",
    },
  })

export type AuthEngine = ReturnType<typeof makeAuthEngine>
