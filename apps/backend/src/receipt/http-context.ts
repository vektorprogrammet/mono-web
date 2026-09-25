/** Receipt HTTP composition options and request principal resolution. */
import type { AuthorizationInstant, CredentialOutcome } from "@vektorprogrammet/domain/authz";
import {
  UnauthenticatedActor,
  type ReceiptCommandPrincipal,
} from "@vektorprogrammet/domain/receipt";
import { Effect, Predicate } from "effect";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import { HttpSemanticFailure } from "../http-semantics.js";
import { hasBetterAuthSessionCredential } from "../session-security.js";
import type { ReceiptApiConfig } from "./config.js";

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

export interface ReceiptIdentityResolvers<E = never, R = never> {
  /** Request credential -> canonical person and one instant; never role or authority facts. */
  readonly resolveAuthorizationPrincipal: (
    request: Request,
  ) => Effect.Effect<ReceiptCommandPrincipal, E, R>;
  /** Request credential -> owner person id; no role or authority facts. */
  readonly resolvePersonId: (request: Request) => Effect.Effect<string, E, R>;
  /** Exact row 42 credential bridge; no token-carried authorization facts. */
  readonly resolveApprovalCredential?: (request: Request) => Effect.Effect<
    {
      readonly credential: AcceptedCredential;
      readonly authorizationInstant: AuthorizationInstant;
    },
    E,
    R
  >;
}

export interface ReceiptApiHttpOptions<E = never, R = never> {
  readonly config: ReceiptApiConfig;
  readonly identity: ReceiptIdentityResolvers<E, R>;
  readonly now?: () => string;

  /**
   * Stable worker claim identity used to recover its stale in-flight effects.
   * The composition root may supply an operationally durable identity.
   */
  readonly outboxClaimId?: string;
}

/** A missing actor with a presented session cookie is an invalid credential, not an absent one. */
export const invalidSessionFailure = <E>(request: Request, cause: E): E | HttpSemanticFailure =>
  cause !== null &&
  (cause === null || Predicate.isObjectOrArray(cause)) &&
  "_tag" in cause &&
  Predicate.isTagged(cause, "UnauthenticatedActor") &&
  hasBetterAuthSessionCredential(request.headers.get("cookie"))
    ? new HttpSemanticFailure("credential.invalid", 401)
    : cause;

export const authorizationPrincipalFor = <E, R>(
  request: Request,
  options: ReceiptApiHttpOptions<E, R>,
) =>
  options.identity.resolveAuthorizationPrincipal(request).pipe(
    Effect.mapError((cause): E | HttpSemanticFailure | UnauthenticatedActor => {
      const classified = invalidSessionFailure(request, cause);

      return classified !== cause
        ? classified
        : cause !== null && Predicate.isObjectOrArray(cause) && "_tag" in cause
          ? cause
          : new UnauthenticatedActor({ message: "authentication required" });
    }),
  );

export const authorizationPrincipalInTransaction = <E, R>(
  request: Request,
  options: ReceiptApiHttpOptions<E, R>,
) =>
  resolveRequestCredentialInTransaction(request, "OAuthUserBearer", { now: options.now }).pipe(
    Effect.catch((cause) => Effect.fail(invalidSessionFailure(request, cause))),
    Effect.flatMap((authenticated) =>
      Predicate.isTagged(authenticated.credential.principal, "Person")
        ? Effect.succeed({
            personId: authenticated.credential.principal.personId,
            authorizationInstant: authenticated.authorizationInstant,
          })
        : Effect.fail(new UnauthenticatedActor({ message: "authentication required" })),
    ),
  );
