/** Admission authorization helpers shared by read and command handlers. */
import type {
  Database,
  IdentitySnapshot,
  OAuthCredentialAuthority,
} from "@vektorprogrammet/database";
import type {
  AdmissionPeriodActor,
  UnauthenticatedActor,
} from "@vektorprogrammet/domain/admission-period";
import { ResourceId, ResourceKind, Scope } from "@vektorprogrammet/domain/authz";
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { Organization } from "@vektorprogrammet/domain/organization";
import { Effect, Predicate } from "effect";
import {
  type OrganizationResolutionError,
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import { genericContext } from "../native-operation.js";
import { authorizeAt, type PersonDecisionInput } from "./http-guard.js";
import type { AdmissionApiHttpOptions } from "./http-context.js";

export const admissionGrantScopes = (actor: AdmissionPeriodActor) =>
  Predicate.isTagged(actor, "GlobalAdmin")
    ? ([Scope.Global()] as const)
    : Predicate.isTagged(actor, "DepartmentAdministrator")
      ? ([Scope.Department({ departmentId: actor.departmentId })] as const)
      : [];

export const returningPersonResource = (personId: string) =>
  Scope.Resource({
    resource: {
      kind: ResourceKind.make("person-profile"),
      id: ResourceId.make(personId),
    },
  });

/**
 * Evaluates one admission person AccessSpec through the generated guard of its endpoint.
 *
 * @remarks
 * It hands the facts of this decision point to `authorize`, the guard that the generated raw
 * handler supplies, which runs `authorizePerson` with the credential that the request presented
 * and then `unreachable("resource.not-found")`: every admission AccessSpec reveals its denials, so
 * authorization never answers 404, and a concealment would be a defect. The guard refuses to run
 * for another operation's frame.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* authorizeAdmissionPerson(authorize, "admissions.createAdmissionPeriod", request, { credential, personId, resolution, grantScopes, now });
 * ```
 *
 * @avoid Calling `authorizePerson` in an admission handler, or evaluating a spec that the handler
 * chose itself: the generated guard owns the AccessSpec of its endpoint. Call this.
 *
 * @construct http-problem
 */
export const authorizeAdmissionPerson = <E>(
  authorize: () => Effect.Effect<unknown, E>,
  operation: string,
  request: Request,
  input: PersonDecisionInput,
): Effect.Effect<void, E> => authorizeAt(authorize, { kind: "Person", operation, request, input });

/**
 * Resolves the current person and authorizes one returning-assistant operation on that person's
 * own profile.
 *
 * @remarks
 * It resolves the request's person credential and organization authority in the caller's
 * transaction at one instant, then evaluates the endpoint's AccessSpec, through the generated
 * guard `authorize`, for that person over their own `person-profile` resource, with the resource
 * as the grant scope. It answers the resolved authority, whose instant the command uses for its
 * own reads.
 *
 * @sideEffects Reads the person's session or token and organization authority in the caller's
 * transaction.
 *
 * @example
 * ```ts
 * const authorization = yield* returningAuthorization(authorize, "admissions.registerReturningAssistant", request, input);
 * ```
 *
 * @avoid Authorizing a returning-assistant operation with the actor of an admission period: the
 * operation acts on the person's own profile, not on a department. Resolve it with this.
 *
 * @construct http-problem
 */
export const returningAuthorization = <E>(
  authorize: () => Effect.Effect<unknown, E>,
  operation: string,
  request: Request,
  input: AdmissionApiHttpOptions,
): Effect.Effect<
  TransactionPersonAuthority,
  IdentityEngineError | UnauthenticatedActor | OrganizationResolutionError | E,
  Database | Organization | IdentitySnapshot | OAuthCredentialAuthority
> =>
  Effect.gen(function* () {
    const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
      now: input.config.now,
    });

    yield* authorizeAdmissionPerson(authorize, operation, request, {
      credential: authorization.credential,
      personId: authorization.authority.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [
          genericContext({
            domainId: "admissions",
            resourceKind: "person-profile",
            resourceId: authorization.authority.personId,
            facts: { ownerPersonId: authorization.authority.personId },
            authorityVersion: "admissions:returning-assistant",
          }),
        ],
      },
      grantScopes: [returningPersonResource(authorization.authority.personId)],
      now: authorization.authorizationInstant,
    });

    return authorization;
  });
