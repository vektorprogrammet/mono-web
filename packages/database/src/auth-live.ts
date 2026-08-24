import { Effect, Layer } from "effect"
import {
  Auth,
  decodeAuthenticatedActor,
  type AuthShape,
} from "@vektorprogrammet/domain/auth"
import { makeAuthEngine, type AuthEngineConfig } from "./auth-engine.js"

/**
 * AuthLive (spec 0054): the concrete `Auth` Service interpretation.
 *
 * Depends on the vektorprogrammet PostgreSQL (same authoritative database as
 * every other capability) through better-auth's pg/Kysely adapter. The
 * better-auth engine is confined here - portable programs see only the typed
 * `Auth` interface from @vektorprogrammet/domain/auth.
 */
export const AuthLive = (config: AuthEngineConfig): Layer.Layer<Auth> =>
  Layer.sync(Auth, () => {
    const engine = makeAuthEngine(config)
    const shape: AuthShape = {
      signIn: async ({ email, password }) => {
        const result = await engine.api.signInEmail({
          body: { email, password },
          asResponse: true,
        })
        if (!result.ok) {
          throw new Error(`sign-in failed with status ${result.status}`)
        }
        const [setCookie] = result.headers.getSetCookie()
        if (setCookie === undefined) {
          throw new Error("sign-in response carried no session cookie")
        }
        const session = await engine.api.getSession({ headers: result.headers })
        if (session?.user == null) {
          throw new Error("session missing directly after sign-in")
        }
        const actor = await decodeAuthenticatedActor({
          personId: session.user.id,
          sessionId: session.session.id,
        }).pipe(Effect.runPromise)
        return { setCookie, actor }
      },
      resolveSession: async (cookieHeader) => {
        const headers = new Headers()
        if (cookieHeader !== undefined && cookieHeader.length > 0) {
          headers.set("cookie", cookieHeader)
        }
        const session = await engine.api.getSession({ headers })
        if (session?.user == null) {
          throw new Error("no active session for request cookies")
        }
        return await decodeAuthenticatedActor({
          personId: session.user.id,
          sessionId: session.session.id,
        }).pipe(Effect.runPromise)
      },
      signOut: async (cookieHeader) => {
        const headers = new Headers()
        if (cookieHeader !== undefined && cookieHeader.length > 0) {
          headers.set("cookie", cookieHeader)
        }
        await engine.api.signOut({ headers })
      },
    }
    return shape
  })
