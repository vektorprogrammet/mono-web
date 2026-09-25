/** Admission HTTP composition options and request actor resolution. */
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  AdmissionRoleDenied,
  AdmissionScopeDenied,
  InactiveActor,
  UnauthenticatedActor,
  type AdmissionPeriodActor,
} from "@vektorprogrammet/domain/admission-period";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  DepartmentId,
  type Organization,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { Effect, Predicate } from "effect";
import {
  admissionActorForDepartment,
  unscopedAdmissionActorFrom,
  type OrganizationResolutionError,
} from "../authority.js";
import type { HttpSemanticFailure } from "../http-semantics.js";
import type { AdmissionApiConfig } from "./config.js";
import { knownAdmissionFailure } from "./http-problem.js";

export interface AdmissionApiHttpOptions {
  readonly config: AdmissionApiConfig;
  /**
   * Resolves the session cookie into a department-scoped actor (spec 0055).
   * `departmentScope` carries canonical request state (payload department or
   * the period's immutable department); undefined resolves the person's own scope.
   */
  readonly resolveActor: (
    request: Request,
    departmentScope?: string,
  ) => Effect.Effect<
    AdmissionPeriodActor,
    | IdentityEngineError
    | UnauthenticatedActor
    | InactiveActor
    | AdmissionScopeDenied
    | AdmissionRoleDenied
    | OrganizationResolutionError
    | HttpSemanticFailure,
    Identity | OAuthCredentialAuthority | Organization
  >;
}

export const requireActive = (actor: AdmissionPeriodActor) =>
  actor.active
    ? Effect.succeed(actor)
    : Effect.fail(new InactiveActor({ personId: actor.personId }));

export const actorFor = (
  request: Request,
  input: AdmissionApiHttpOptions,
  departmentScope?: string,
) =>
  input
    .resolveActor(request, departmentScope)
    .pipe(
      Effect.catch((cause) =>
        Effect.fail(
          cause !== null && (cause === null || Predicate.isObjectOrArray(cause)) && "_tag" in cause
            ? cause
            : new UnauthenticatedActor({ message: "authentication required" }),
        ),
      ),
    );

export const admissionActorForAuthority = (
  authority: OrganizationPersonAuthority,
  departmentScope?: string,
) =>
  Effect.try({
    try: () =>
      departmentScope === undefined
        ? unscopedAdmissionActorFrom(authority)
        : admissionActorForDepartment(authority, DepartmentId.make(departmentScope)),
    catch: knownAdmissionFailure,
  }).pipe(Effect.flatMap(requireActive));
