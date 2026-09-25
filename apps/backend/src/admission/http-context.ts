/** Admission HTTP composition options and request actor resolution. */
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  AdmissionRoleDenied,
  AdmissionScopeDenied,
  InactiveActor,
  type AdmissionPeriodActor,
  type UnauthenticatedActor,
} from "@vektorprogrammet/domain/admission-period";
import type { Identity, IdentityEngineError } from "@vektorprogrammet/domain/identity";
import {
  DepartmentId,
  type Organization,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { Effect } from "effect";
import {
  admissionActorForDepartment,
  unscopedAdmissionActorFrom,
  type OrganizationResolutionError,
} from "../authority.js";
import type { AdmissionApiConfig } from "./config.js";

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
    | OrganizationResolutionError,
    Identity | OAuthCredentialAuthority | Organization
  >;
}

export const requireActive = (actor: AdmissionPeriodActor) =>
  actor.active
    ? Effect.succeed(actor)
    : Effect.fail(new InactiveActor({ personId: actor.personId }));

/**
 * The admission actor of one department scope. The mapping throws only its
 * three denials; anything else it throws is a defect.
 *
 * @construct http-problem
 */
export const admissionActorForAuthority = (
  authority: OrganizationPersonAuthority,
  departmentScope?: string,
) =>
  Effect.try({
    try: () =>
      departmentScope === undefined
        ? unscopedAdmissionActorFrom(authority)
        : admissionActorForDepartment(authority, DepartmentId.make(departmentScope)),
    catch: (cause) => {
      if (
        cause instanceof InactiveActor ||
        cause instanceof AdmissionScopeDenied ||
        cause instanceof AdmissionRoleDenied
      )
        return cause;
      throw cause;
    },
  }).pipe(Effect.flatMap(requireActive));
