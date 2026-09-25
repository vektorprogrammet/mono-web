/** Admission HTTP composition options and request actor resolution. */
import type { OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  AdmissionPeriodActorSchema,
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
import { admissionActorForDepartment, type OrganizationResolutionError } from "../authority.js";
import type { HttpSemanticFailure } from "../http-semantics.js";
import type { AdmissionApiConfig } from "./config.js";
import { knownAdmissionFailure } from "./http-problem.js";

export interface AdmissionApiHttpOptions {
  readonly config: AdmissionApiConfig;
  /**
   * Resolves the session cookie into a department-scoped actor (spec 0055).
   * `departmentScope` carries canonical request state (payload department or
   * the period's immutable department); undefined means global-only scope.
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
    try: () => {
      if (departmentScope !== undefined) {
        return admissionActorForDepartment(authority, DepartmentId.make(departmentScope));
      }

      if (authority.globalAdministrator !== "Active") {
        throw authority.globalAdministrator === "Inactive"
          ? new InactiveActor({ personId: authority.personId })
          : new UnauthenticatedActor({ message: "no authority for unscoped management route" });
      }

      return AdmissionPeriodActorSchema.cases.GlobalAdmin.make({
        personId: authority.personId,
        active: true,
      });
    },
    catch: knownAdmissionFailure,
  }).pipe(Effect.flatMap(requireActive));
