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
import {
  ReadReturningAssistantOptionsEndpoint,
  RegisterReturningAssistantEndpoint,
  reflectAccessSpec,
} from "@vektorprogrammet/http-api";
import type { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate } from "effect";
import {
  type OrganizationResolutionError,
  resolveRequestPersonAuthorityInTransaction,
  type TransactionPersonAuthority,
} from "../authority.js";
import { authorizePerson, personPresentation, unreachable } from "../http-api/problem.js";
import { genericContext, type NativePersonAuthorization } from "../native-operation.js";
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
 * Evaluates one admission person AccessSpec.
 *
 * @remarks
 * It runs `authorizePerson` with the credential that the request presented, then
 * `unreachable("resource.not-found")`: every admission AccessSpec reveals its denials, so
 * authorization never answers 404, and a concealment would be a defect.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* authorizeAdmissionPerson(request, { spec, credential, personId, resolution, grantScopes, now });
 * ```
 *
 * @avoid Calling `authorizePerson` in an admission handler and declaring resource.not-found on the
 * endpoint: admission specs reveal their denials, so that problem never occurs. Call this.
 *
 * @construct http-problem
 */
export const authorizeAdmissionPerson = (
  request: Request,
  input: NativePersonAuthorization,
): Effect.Effect<
  void,
  Problem<"authority.denied"> | Problem<"credential.invalid"> | Problem<"credential.missing">
> => authorizePerson(input, personPresentation(request)).pipe(unreachable("resource.not-found"));

/**
 * Resolves the current person and authorizes one returning-assistant operation on that person's
 * own profile.
 *
 * @remarks
 * It resolves the request's person credential and organization authority in the caller's
 * transaction at one instant, then evaluates the endpoint's AccessSpec for that person over their
 * own `person-profile` resource, with the resource as the grant scope. It answers the resolved
 * authority, whose instant the command uses for its own reads.
 *
 * @sideEffects Reads the person's session or token and organization authority in the caller's
 * transaction.
 *
 * @example
 * ```ts
 * const authorization = yield* returningAuthorization(request, input, RegisterReturningAssistantEndpoint);
 * ```
 *
 * @avoid Authorizing a returning-assistant operation with the actor of an admission period: the
 * operation acts on the person's own profile, not on a department. Resolve it with this.
 *
 * @construct http-problem
 */
export const returningAuthorization = (
  request: Request,
  input: AdmissionApiHttpOptions,
  endpoint:
    | typeof ReadReturningAssistantOptionsEndpoint
    | typeof RegisterReturningAssistantEndpoint,
): Effect.Effect<
  TransactionPersonAuthority,
  | IdentityEngineError
  | UnauthenticatedActor
  | OrganizationResolutionError
  | Problem<"authority.denied">
  | Problem<"credential.invalid">
  | Problem<"credential.missing">,
  Database | Organization | IdentitySnapshot | OAuthCredentialAuthority
> =>
  Effect.gen(function* () {
    const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
      now: input.config.now,
    });

    yield* authorizeAdmissionPerson(request, {
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
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
