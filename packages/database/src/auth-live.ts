import { Context, Effect, Layer, Scope } from "effect";
import {
  Identity,
  IdentityEngineError,
  IdentityInvalidCredentials,
  IdentityRateLimited,
  IdentitySessionNotFound,
  decodeIdentityActor,
  type IdentityShape,
} from "@vektorprogrammet/domain/identity";
import { makeAuthEngine, makeAuthPool, type AuthEngineConfig } from "./auth-engine.js";

/**
 * AuthLive (spec 0054): the concrete `Identity` Service interpretation.
 *
 * Depends on the vektorprogrammet PostgreSQL (same authoritative database as
 * every other capability) through better-auth's pg adapter. The better-auth
 * engine is confined here - portable programs see only the typed `Identity`
 * interface from @vektorprogrammet/domain/identity plus the standard Request ->
 * Response auth handler mounted at /api/auth/*.
 *
 * The engine and its pg Pool are constructed ONCE per Layer scope. Both the
 * Identity Service and the AuthEngine service share that single instance, and
 * releasing any Layer built over it closes the pool.
 */

/** The one better-auth instance behind this module's services. */
export type AuthEngineInstance = ReturnType<typeof makeAuthEngine>;

export interface AuthEngineService {
  /** The single better-auth instance behind this Layer's Identity Service. */
  readonly engine: AuthEngineInstance;
  /**
   * Standard Request/Response handler for `/api/auth/*` (spec 0054 §4).
   * Expects requests whose path is already rooted at the auth surface.
   */
  readonly handler: (request: Request) => Promise<Response>;
}

export class AuthEngine extends Context.Service<AuthEngine, AuthEngineService>()(
  "@vektorprogrammet/database/AuthEngine",
) {}

const cookieHeaders = (cookieHeader: string | undefined): Headers => {
  const headers = new Headers();
  if (cookieHeader !== undefined && cookieHeader.length > 0) {
    headers.set("cookie", cookieHeader);
  }
  return headers;
};

const identityShape = (engine: AuthEngineInstance): IdentityShape => ({
  signIn: async ({ email, password }) => {
    const result = await engine.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    if (!result.ok) {
      if (result.status === 401) throw new IdentityInvalidCredentials();
      if (result.status === 429) throw new IdentityRateLimited();
      throw new IdentityEngineError({
        operation: "signIn",
        message: `authentication provider returned status ${result.status}`,
      });
    }
    const [setCookie] = result.headers.getSetCookie();
    if (setCookie === undefined) {
      throw new IdentityEngineError({
        operation: "signIn",
        message: "sign-in response carried no session cookie",
      });
    }
    // getSession reads request cookie headers only - rebuild them from the
    // issued Set-Cookie instead of reusing the response header set.
    const session = await engine.api.getSession({
      headers: cookieHeaders(setCookie.split(";")[0]),
    });
    if (session?.user == null) {
      throw new IdentityEngineError({
        operation: "signIn",
        message: "session missing directly after sign-in",
      });
    }
    const actor = await decodeIdentityActor({
      personId: session.user.id,
      sessionId: session.session.id,
      expiresAt: session.session.expiresAt,
    }).pipe(Effect.runPromise);
    return { setCookie, actor };
  },
  resolveSession: async (cookieHeader) => {
    const session = await engine.api.getSession({ headers: cookieHeaders(cookieHeader) });
    if (session?.user == null) {
      // Typed so the backend maps stale/invalid cookies to UnauthenticatedActor
      // (401) instead of an untagged IdentityEngineError (503). The
      // sessionToken field is deliberately empty: never echo session tokens.
      throw new IdentitySessionNotFound({ sessionToken: "" });
    }
    return await decodeIdentityActor({
      personId: session.user.id,
      sessionId: session.session.id,
      expiresAt: session.session.expiresAt,
    }).pipe(Effect.runPromise);
  },
  signOut: async (cookieHeader) => {
    await engine.api.signOut({ headers: cookieHeaders(cookieHeader) });
  },
});

/** One engine + its pg Pool per scope; release closes the pool. */
const makeAuthEngineService = (
  config: AuthEngineConfig,
): Effect.Effect<AuthEngineService, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const pool = makeAuthPool(config);
      const engine = makeAuthEngine(config, pool);
      return {
        pool,
        service: {
          engine,
          handler: (request: Request) => engine.handler(request),
        } satisfies AuthEngineService,
      };
    }),
    ({ pool }) => Effect.promise(() => pool.end()).pipe(Effect.ignore, Effect.asVoid),
  ).pipe(Effect.map(({ service }) => service));

/**
 * ONE scoped construction exposing both the engine service (for the
 * /api/auth/* handler) and the Identity interpretation. A single acquisition
 * is essential: splitting into nested layers would close the engine's pool
 * when an inner build scope ends while request handlers still need it.
 */
export const AuthLive = (config: AuthEngineConfig): Layer.Layer<Identity | AuthEngine> =>
  Layer.effectContext(
    Effect.map(makeAuthEngineService(config), (service) =>
      Context.merge(
        Context.make(AuthEngine, service),
        Context.make(Identity, identityShape(service.engine)),
      ),
    ),
  );
