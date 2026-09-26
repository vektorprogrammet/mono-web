/** Content HTTP operation identities, request actor types, and request actor resolution. */
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ContentAuthorityInactive,
  ContentNotInScope,
  resolveContentActor,
  type ContentActor,
} from "@vektorprogrammet/domain/content";
import { Organization, type PersonId } from "@vektorprogrammet/domain/organization";
import { ContentApi } from "@vektorprogrammet/http-api";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Predicate } from "effect";
import type { HttpApiGroup } from "effect/unstable/httpapi";
import {
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";

export interface ContentRequestActor {
  readonly personId: PersonId;
  readonly authorizationInstant: string;
}

export type ContentRequestActorResolver<E, R> = (
  request: Request,
) => Effect.Effect<ContentRequestActor, E, R>;

/** An endpoint declared by the content HttpApi contract. */
export type ContentEndpoint = HttpApiGroup.Endpoints<typeof ContentApi>;

/**
 * Qualified operation id published for a content endpoint, derived by the native
 * provenance rule `HttpApiGroup.identifier.HttpApiEndpoint.identifier`.
 */
export const contentOperationId = (endpoint: ContentEndpoint) =>
  `${ContentApi.identifier}.${endpoint.identifier}` as const;

export interface AuthorizedContentActor extends ContentRequestActor {
  readonly contentActor: ContentActor;
}

export interface TransactionalAuthorizedContentActor extends AuthorizedContentActor {
  readonly credential: TransactionPersonAuthority["credential"];
}

/**
 * Resolves the staff person of a snapshot read and its content actor at the
 * person's authorization instant.
 *
 * @construct http-problem
 */
export const authorizedActor = <E, R>(
  request: Request,
  resolveActor: ContentRequestActorResolver<E, R>,
  presentation: CredentialPresentation,
) =>
  Effect.gen(function* () {
    // The resolver only authenticates. A rejected person is answered from the
    // credential the request presented; any other failure is internal.
    const actor = yield* resolveActor(request).pipe(
      Effect.mapError((failure) =>
        Predicate.isTagged(failure, "UnauthenticatedActor")
          ? Problem.unauthenticated(presentation)
          : Problem.make("internal.error"),
      ),
    );

    const authority = yield* Organization.use(({ resolvePersonAuthority }) =>
      resolvePersonAuthority(actor.personId, actor.authorizationInstant),
    );

    const decision = resolveContentActor(authority);

    if (Predicate.isTagged(decision, "Deny")) {
      return yield* decision.reason === "AuthorityInactive"
        ? new ContentAuthorityInactive({})
        : new ContentNotInScope({});
    }

    return { ...actor, contentActor: decision.value };
  });

/**
 * Resolves the staff person of a command, its credential, and its content
 * actor inside the command's transaction.
 *
 * @construct http-problem
 */
export const authorizedActorInTransaction = (request: Request) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestPersonAuthorityInTransaction(request);

    if (!Predicate.isTagged(authenticated.credential.principal, "Person")) {
      return yield* new UnauthenticatedActor({ message: "authentication required" });
    }

    const decision = resolveContentActor(authenticated.authority);

    if (Predicate.isTagged(decision, "Deny")) {
      return yield* decision.reason === "AuthorityInactive"
        ? new ContentAuthorityInactive({})
        : new ContentNotInScope({});
    }

    return {
      personId: authenticated.credential.principal.personId,
      authorizationInstant: authenticated.authorizationInstant,
      credential: authenticated.credential,
      contentActor: decision.value,
    };
  });
