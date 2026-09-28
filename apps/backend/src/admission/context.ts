/** Admission actors: the department-scoped actor of one person's organization authority. */
import {
  AdmissionRoleDenied,
  AdmissionScopeDenied,
  InactiveActor,
  type AdmissionPeriodActor,
} from "@vektorprogrammet/domain/admission-period";
import {
  DepartmentId,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import { Effect, Predicate, Schema } from "effect";
import { admissionActorForDepartment, unscopedAdmissionActorFrom } from "../authority.js";
import { dual } from "effect/Function";

export const requireActive = (actor: AdmissionPeriodActor) =>
  actor.active
    ? Effect.succeed(actor)
    : Effect.fail(InactiveActor.make({ personId: actor.personId }));

const isAdmissionActorDenial = Schema.is(
  Schema.Union([InactiveActor, AdmissionScopeDenied, AdmissionRoleDenied]),
);

/**
 * The admission actor of one department scope.
 *
 * @remarks
 * It maps the organization authority of a person to the admission actor of `departmentScope`,
 * or to the person's own scope when none is given, and requires that actor to be active. The
 * mapping throws only its three denials, which become failures; anything else that it throws is a
 * defect.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * const actor = yield* admissionActorForAuthority(authorization.authority, request.departmentId);
 * ```
 *
 * @avoid Mapping the authority with `admissionActorForDepartment` in a handler: its denials are
 * throws, which escape the error channel as defects. Map it with this.
 *
 * @construct rpc-problem
 */
export const admissionActorForAuthority: {
  (
    authority: OrganizationPersonAuthority,
    departmentScope?: string,
  ): Effect.Effect<
    AdmissionPeriodActor,
    AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor
  >;
  (
    departmentScope?: string,
  ): (
    authority: OrganizationPersonAuthority,
  ) => Effect.Effect<
    AdmissionPeriodActor,
    AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor
  >;
} = dual(
  (args) => Predicate.isObject(args[0]),
  (
    authority: OrganizationPersonAuthority,
    departmentScope?: string,
  ): Effect.Effect<
    AdmissionPeriodActor,
    AdmissionRoleDenied | AdmissionScopeDenied | InactiveActor
  > =>
    Effect.try({
      try: () =>
        departmentScope === undefined
          ? unscopedAdmissionActorFrom(authority)
          : admissionActorForDepartment(authority, DepartmentId.make(departmentScope)),
      catch: (cause) => {
        if (isAdmissionActorDenial(cause)) return cause;
        throw cause;
      },
    }).pipe(Effect.flatMap(requireActive)),
);
