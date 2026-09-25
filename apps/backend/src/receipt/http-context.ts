/** Receipt HTTP composition options and request principal resolution. */
import type { AuthorizationInstant, CredentialOutcome } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  UnauthenticatedActor,
  type ReceiptCommandPrincipal,
} from "@vektorprogrammet/domain/receipt";
import { Effect, Predicate } from "effect";
import { resolveRequestCredentialInTransaction } from "../authority.js";
import type { ReceiptApiConfig } from "./config.js";

type AcceptedCredential = Extract<CredentialOutcome, { readonly _tag: "Accepted" }>;

/** A composed identity resolver rejects the credential or finds Identity unavailable; nothing else. */
export type ReceiptIdentityFailure = UnauthenticatedActor | IdentityEngineError;

export interface ReceiptIdentityResolvers<E extends ReceiptIdentityFailure = never, R = never> {
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

export interface ReceiptApiHttpOptions<E extends ReceiptIdentityFailure = never, R = never> {
  readonly config: ReceiptApiConfig;
  readonly identity: ReceiptIdentityResolvers<E, R>;
  readonly now?: () => string;

  /**
   * Stable worker claim identity used to recover its stale in-flight effects.
   * The composition root may supply an operationally durable identity.
   */
  readonly outboxClaimId?: string;
}

/** Resolves the current Person credential through the caller's transaction at one instant. */
export const authorizationPrincipalInTransaction = <R>(
  request: Request,
  options: ReceiptApiHttpOptions<ReceiptIdentityFailure, R>,
) =>
  resolveRequestCredentialInTransaction(request, "OAuthUserBearer", { now: options.now }).pipe(
    Effect.flatMap((authenticated) =>
      Predicate.isTagged(authenticated.credential.principal, "Person")
        ? Effect.succeed({
            personId: authenticated.credential.principal.personId,
            authorizationInstant: authenticated.authorizationInstant,
          })
        : Effect.fail(new UnauthenticatedActor({ message: "authentication required" })),
    ),
  );
