/** Content HTTP operation inventory, request actor types, and request actor resolution. */
import {
  ContentAuthorityInactive,
  ContentNotInScope,
  resolveContentActor,
  type ContentActor,
} from "@vektorprogrammet/domain/content";
import { Organization, type PersonId } from "@vektorprogrammet/domain/organization";
import { Effect, Predicate } from "effect";
import {
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import { HttpSemanticFailure } from "../http-semantics.js";

export interface ContentRequestActor {
  readonly personId: PersonId;
  readonly authorizationInstant: string;
}

export type ContentRequestActorResolver<E, R> = (
  request: Request,
) => Effect.Effect<ContentRequestActor, E, R>;

export const CONTENT_NATIVE_OPERATION_IDS = [
  "content.readContentWorkspace",
  "content.createArticle",
  "content.readArticle",
  "content.reviseArticle",
  "content.publishArticle",
  "content.unpublishArticle",
  "content.listNews",
  "content.readNewsArticle",
] as const;

export interface AuthorizedContentActor extends ContentRequestActor {
  readonly contentActor: ContentActor;
}

export interface TransactionalAuthorizedContentActor extends AuthorizedContentActor {
  readonly credential: TransactionPersonAuthority["credential"];
}

export const authorizedActor = <E, R>(
  request: Request,
  resolveActor: ContentRequestActorResolver<E, R>,
) =>
  Effect.gen(function* () {
    const actor = yield* resolveActor(request);

    const authority = yield* Organization.use(({ resolvePersonAuthority }) =>
      resolvePersonAuthority(actor.personId, actor.authorizationInstant),
    );

    const decision = resolveContentActor(authority);

    if (Predicate.isTagged(decision, "Deny")) {
      return yield* Effect.fail(
        decision.reason === "AuthorityInactive"
          ? new ContentAuthorityInactive({})
          : new ContentNotInScope({}),
      );
    }

    return { ...actor, contentActor: decision.value };
  });

export const authorizedActorInTransaction = (request: Request) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestPersonAuthorityInTransaction(request);

    if (!Predicate.isTagged(authenticated.credential.principal, "Person")) {
      return yield* Effect.fail(new HttpSemanticFailure("credential.invalid", 401));
    }

    const decision = resolveContentActor(authenticated.authority);

    if (Predicate.isTagged(decision, "Deny")) {
      return yield* Effect.fail(
        decision.reason === "AuthorityInactive"
          ? new ContentAuthorityInactive({})
          : new ContentNotInScope({}),
      );
    }

    return {
      personId: authenticated.credential.principal.personId,
      authorizationInstant: authenticated.authorizationInstant,
      credential: authenticated.credential,
      contentActor: decision.value,
    };
  });
