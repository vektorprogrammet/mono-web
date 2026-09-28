/**
 * Content request actors: the staff person of a read, resolved at one authorization instant, and
 * the staff person of a command, resolved inside the command's transaction.
 */
import { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import {
  ContentAuthorityInactive,
  ContentNotInScope,
  resolveContentActor,
} from "@vektorprogrammet/domain/content";
import {
  Organization,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { Effect, Predicate } from "effect";
import type { Headers } from "effect/unstable/http";
import {
  resolveRequestPersonAtInstant,
  resolveRequestPersonAuthorityInTransaction,
} from "../authority.js";
import { credentialRequestOf } from "../rpc/credential.js";

/**
 * A person with no content authority is denied before any article is read: an inactive authority
 * and a person outside every content scope each fail as their own content failure.
 */
const requireContentActor = (authority: OrganizationPersonAuthority) => {
  const decision = resolveContentActor(authority);

  if (Predicate.isTagged(decision, "Deny")) {
    return decision.reason === "AuthorityInactive"
      ? Effect.fail(ContentAuthorityInactive.make({}))
      : Effect.fail(ContentNotInScope.make({}));
  }

  return Effect.succeed(decision.value);
};

/**
 * Resolves the staff person of a read at one authorization instant, and requires a content actor
 * of the person's organization projection at that instant.
 */
export const readActor = (input: {
  readonly headers: Headers.Headers;
  readonly now: (() => string) | undefined;
}) =>
  Effect.gen(function* () {
    const actor = yield* resolveRequestPersonAtInstant(credentialRequestOf(input.headers), {
      now: input.now,
    });

    const authority = yield* Organization.use(({ resolvePersonAuthority }) =>
      resolvePersonAuthority(actor.personId, actor.authorizationInstant),
    );

    yield* requireContentActor(authority);

    return actor;
  });

/**
 * Resolves the staff person of a command, its credential, and its content actor inside the
 * command's transaction.
 */
export const commandActorInTransaction = (headers: Headers.Headers) =>
  Effect.gen(function* () {
    const authenticated = yield* resolveRequestPersonAuthorityInTransaction(
      credentialRequestOf(headers),
    );

    if (!Predicate.isTagged(authenticated.credential.principal, "Person")) {
      return yield* UnauthenticatedActor.make({ message: "authentication required" });
    }

    yield* requireContentActor(authenticated.authority);

    return {
      personId: authenticated.credential.principal.personId,
      authorizationInstant: authenticated.authorizationInstant,
      credential: authenticated.credential,
    };
  });

export type ContentCommandActor = Effect.Success<ReturnType<typeof commandActorInTransaction>>;
