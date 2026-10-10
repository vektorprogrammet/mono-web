import { Data, Schema } from "effect";
import { AdmissionPeriodId } from "../admission-period/schema.js";
import {
  PublicApplicationEmailSchema,
  PublicApplicationIdSchema,
  PublicApplicationNameSchema,
  PublicApplicationPhoneSchema,
  PublicApplicationYearOfStudySchema,
} from "../application/schema.js";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import { DepartmentId, SemesterId } from "../organization/schema.js";
import { DelegationArea, type OrganizationCapability } from "../authz/delegation.js";
import { delegationsReaching, ReachScope, ReachTarget, scopeCovers } from "../authz/reach.js";

/**
 * The admission outcome of one application. Admission is not scheduling: an admitted person may
 * have no school placement and stays an assistant, so an unplaced Admitted assistant can still
 * cover a dated service. `Substitute` is not an outcome. Only the history that predates this
 * policy keeps that literal, as internal evidence that no public type exposes.
 */
export const AdmissionOutcome = Schema.Literals(["Admitted", "Rejected"]);

export type AdmissionOutcome = typeof AdmissionOutcome.Type;

/**
 * What the outcome of an application rests on. An interviewed applicant rests on the effective
 * recommendation of the interview: `Ja` is Admitted and `Nei` is Rejected, and neither can be
 * overridden. `Kanskje`, and a returning assistant who registered without an interview, need an
 * explicit Rekruttering decision. `Unreviewed` has neither, so no new decision can be made; only
 * a revision that predates this policy can stand.
 */
export const AdmissionOutcomeBasis = Schema.Literals([
  "Ja",
  "Kanskje",
  "Nei",
  "Returning",
  "Unreviewed",
]);

export type AdmissionOutcomeBasis = typeof AdmissionOutcomeBasis.Type;

/** Unannounced explicit decisions may be revised against the same cited basis; announcement is final. */
export const AdmissionOutcomeState = Schema.Literals(["ApplicationSubmitted", "OutcomeAnnounced"]);

export type AdmissionOutcomeState = typeof AdmissionOutcomeState.Type;

export const AdmissionOutcomeScope = Schema.Struct({
  departmentId: DepartmentId,
  semesterId: SemesterId,
});

export type AdmissionOutcomeScope = typeof AdmissionOutcomeScope.Type;

export const AdmissionOutcomeCommand = Schema.Struct({ outcome: AdmissionOutcome });

export type AdmissionOutcomeCommand = typeof AdmissionOutcomeCommand.Type;

/**
 * One application of the scope's admission period. `outcome` is the effective outcome, or null
 * while none follows. `revision` changes with every decision and with the announcement, so a
 * validator derived from it is stale after either.
 */
export const AdmissionOutcomeEntry = Schema.Struct({
  applicationId: PublicApplicationIdSchema,
  admissionPeriodId: AdmissionPeriodId,
  departmentId: DepartmentId,
  semesterId: SemesterId,
  firstName: PublicApplicationNameSchema,
  lastName: PublicApplicationNameSchema,
  email: PublicApplicationEmailSchema,
  phone: PublicApplicationPhoneSchema,
  yearOfStudy: PublicApplicationYearOfStudySchema,
  basis: AdmissionOutcomeBasis,
  state: AdmissionOutcomeState,
  outcome: Schema.NullOr(AdmissionOutcome),
  /** The person holds an active placement in the application's department and semester. */
  placed: Schema.Boolean,
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});

export type AdmissionOutcomeEntry = typeof AdmissionOutcomeEntry.Type;

export const AdmissionOutcomeBoard = Schema.Struct({
  admissionPeriodId: Schema.NullOr(AdmissionPeriodId),
  entries: Schema.Array(AdmissionOutcomeEntry),
});

export type AdmissionOutcomeBoard = typeof AdmissionOutcomeBoard.Type;

export const AdmissionOutcomeScopes = Schema.Struct({
  departments: Schema.Array(Schema.Struct({ departmentId: DepartmentId, name: Schema.String })),
  semesters: Schema.Array(
    Schema.Struct({ semesterId: SemesterId, startAt: Schema.String, endAt: Schema.String }),
  ),
});

export type AdmissionOutcomeScopes = typeof AdmissionOutcomeScopes.Type;

export class AdmissionOutcomeFailure extends Data.TaggedError("AdmissionOutcomeFailure")<{
  readonly code:
    | "authority.denied"
    | "resource.not-found"
    | "scope.invalid"
    | "admission-outcome.derived"
    | "admission-outcome.unreviewed"
    | "admission-outcome.undecided"
    | "admission-outcome.placement-active"
    | "admission-outcome.final";
  readonly status: 403 | 404 | 409 | 422;
}> {}

/** Internal cause information must not enter a public response. */
export class AdmissionOutcomePersistenceError extends Data.TaggedError(
  "AdmissionOutcomePersistenceError",
)<{
  readonly code: "internal.error" | "transaction.conflict";
  readonly status: 409 | 500;
  readonly cause: unknown;
}> {}

export type AdmissionOutcomeOperationFailure =
  | AdmissionOutcomeFailure
  | AdmissionOutcomePersistenceError;

/**
 * Whether an active global administrator acts, or a current delegation of the capability reaches
 * the department. A board or team leadership alone does not: Rekruttering decides and the school
 * coordinator announces only where a delegation names them, and an ended or other-department
 * delegation confers nothing. `delegationsReaching` and `scopeCovers` are the canonical reach.
 */
export const holdsDelegatedDepartmentCapability = (
  authority: OrganizationPersonAuthority,
  capability: OrganizationCapability,
  departmentId: DepartmentId,
): boolean =>
  authority.globalAdministrator === "Active" ||
  delegationsReaching(authority, capability).some((delegation) =>
    scopeCovers(
      DelegationArea.guards.Department(delegation.area)
        ? ReachScope.Department({ departmentId: delegation.area.departmentId })
        : ReachScope.Organization(),
      ReachTarget.Department({ departmentId }),
    ),
  );

/**
 * Whoever holds a current `admissions.outcomes` delegation in the department, or is an active
 * global administrator, decides the outcomes that the interview does not derive. A department
 * board leader without the delegation, and a plain department member, are denied.
 */
export const admissionOutcomePermission = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): "Denied" | "Decide" =>
  holdsDelegatedDepartmentCapability(authority, "admissions.outcomes", departmentId)
    ? "Decide"
    : "Denied";

/**
 * The school coordinator announces: a current `placements.coordinate` delegation of
 * Skolekoordinering in the department, or an active global administrator. A board leadership
 * alone does not announce.
 */
export const canAnnounceAdmissionOutcome = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): boolean => holdsDelegatedDepartmentCapability(authority, "placements.coordinate", departmentId);
