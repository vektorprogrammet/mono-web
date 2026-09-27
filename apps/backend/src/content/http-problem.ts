/** Content failures and the problem each one answers. */
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
import type {
  ArticleNotFound,
  ContentManagementFailure,
  ContentUnauthenticatedActor,
} from "@vektorprogrammet/domain/content";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type {
  OrganizationDecodeError,
  OrganizationPersistenceError,
} from "@vektorprogrammet/domain/organization";
import { type CredentialPresentation, Problem } from "@vektorprogrammet/http-api/http-semantics";
import {
  type CredentialCases,
  type ProblemCases,
  type ProblemMapper,
  problemMapper,
} from "../http-api/problem.js";

/** Every content failure that a content handler answers, but a rejected credential. */
type ContentFailure =
  | Exclude<ContentManagementFailure, ContentUnauthenticatedActor>
  | ArticleNotFound;

const contentCases = {
  AuthorityInactive: () => Problem.make("authority.denied"),
  NotInScope: () => Problem.make("authority.denied"),
  NotPublisher: () => Problem.make("authority.denied"),
  DraftNotOwned: () => Problem.make("authority.denied"),
  ArticleNotFound: () => Problem.make("content.article-not-found"),
  SlugConflict: () => Problem.make("content.slug-conflict"),
  DepartmentNotFound: () => Problem.make("content.department-not-found"),
  CommandConflict: () => Problem.make("content.lifecycle-conflict"),
  ContentIntegrityError: () => Problem.make("content.integrity-error"),
  ContentPersistenceError: () => Problem.make("content.unavailable"),
  ContentDecodeError: () => Problem.make("internal.error"),
} satisfies ProblemCases<ContentFailure>;

/**
 * The one answer for every content domain failure.
 *
 * @remarks
 * An inactive authority, a department outside the actor's scope, a missing publisher role, and
 * another author's draft answer authority.denied. The article, slug, department, and lifecycle
 * failures answer their content problems, an unavailable store answers content.unavailable, and a
 * stored value that does not decode answers internal.error.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * read.pipe(contentProblems, contentActorProblems(presentation));
 * ```
 *
 * @avoid Mapping a content failure in a handler: the content endpoints then answer one failure
 * differently. Pipe the handler's effect through this.
 *
 * @construct http-problem
 */
export const contentProblems: ProblemMapper<ContentFailure, typeof contentCases> =
  problemMapper<ContentFailure>()(contentCases);

/** A staff person whom ingress admitted, rejected by the content actor resolution. */
type ContentActorFailure =
  | UnauthenticatedActor
  | ContentUnauthenticatedActor
  | IdentityEngineError
  | OrganizationDecodeError
  | OrganizationPersistenceError;

const contentActorFixedCases = {
  IdentityEngineError: () => Problem.make("internal.error"),
  OrganizationDecodeError: () => Problem.make("internal.error"),
  OrganizationPersistenceError: () => Problem.make("internal.error"),
} satisfies ProblemCases<Exclude<ContentActorFailure, { readonly _tag: "UnauthenticatedActor" }>>;

/** The cases of `contentActorProblems`. */
type ContentActorCases = typeof contentActorFixedCases & CredentialCases<"UnauthenticatedActor">;

/**
 * A staff person rejected after ingress is answered from the credential the request presented.
 *
 * @remarks
 * A rejected staff person answers `Problem.unauthenticated(presentation)`: credential.missing or
 * credential.invalid, as the request's evidence says. An unavailable identity or organization
 * projection answers internal.error.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * read.pipe(contentProblems, contentActorProblems(presentation));
 * ```
 *
 * @avoid Answering a rejected staff person with a fixed credential code: a request that presented
 * a rejected session would be told that it presented none. Pipe the actor resolution through this.
 *
 * @construct http-problem
 */
export const contentActorProblems = (
  presentation: CredentialPresentation,
): ProblemMapper<ContentActorFailure, ContentActorCases> =>
  problemMapper<ContentActorFailure>()<ContentActorCases>({
    ...contentActorFixedCases,
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
  });
