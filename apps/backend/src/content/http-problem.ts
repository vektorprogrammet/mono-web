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
import { problemMapper } from "../http-api/problem.js";

/**
 * The one answer for every content domain failure.
 *
 * @construct http-problem
 */
export const contentProblems = problemMapper<
  Exclude<ContentManagementFailure, ContentUnauthenticatedActor> | ArticleNotFound
>()({
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
});

/**
 * A staff person rejected after ingress is answered from the credential the
 * request presented. An unavailable identity or organization projection is an
 * internal error.
 *
 * @construct http-problem
 */
export const contentActorProblems = (presentation: CredentialPresentation) =>
  problemMapper<
    | UnauthenticatedActor
    | ContentUnauthenticatedActor
    | IdentityEngineError
    | OrganizationDecodeError
    | OrganizationPersistenceError
  >()({
    UnauthenticatedActor: () => Problem.unauthenticated(presentation),
    IdentityEngineError: () => Problem.make("internal.error"),
    OrganizationDecodeError: () => Problem.make("internal.error"),
    OrganizationPersistenceError: () => Problem.make("internal.error"),
  });
