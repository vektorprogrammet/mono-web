import { Data, Match, Predicate, Schema } from "effect";
import { AdmissionPeriodId } from "../admission-period/schema.js";
import {
  PublicApplicationEmailSchema,
  PublicApplicationIdSchema,
  PublicApplicationNameSchema,
  PublicApplicationPhoneSchema,
  PublicApplicationYearOfStudySchema,
} from "../application/schema.js";
import {
  mapOrganizationAuthorityToDepartmentActor,
  type OrganizationPersonAuthority,
} from "../organization/authority.js";
import { DepartmentId, SemesterId } from "../organization/schema.js";
import { canManagePlacements } from "../placements/policy.js";

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

/** `ApplicationSubmitted` may still be decided; `OutcomeAnnounced` is terminal. */
export const AdmissionOutcomeState = Schema.Literals(["ApplicationSubmitted", "OutcomeAnnounced"]);

export type AdmissionOutcomeState = typeof AdmissionOutcomeState.Type;

/**
 * The outcome that follows from a basis and the latest recorded revision, or null while none
 * follows. A recorded revision never overrides `Ja` or `Nei`.
 */
export const effectiveAdmissionOutcome = (
  basis: AdmissionOutcomeBasis,
  decision: AdmissionOutcome | null,
): AdmissionOutcome | null =>
  Match.value(basis).pipe(
    Match.when("Ja", (): AdmissionOutcome => "Admitted"),
    Match.when("Nei", (): AdmissionOutcome => "Rejected"),
    Match.orElse(() => decision),
  );

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
 * Whoever holds `admissions.outcomes` in the department decides the outcomes that the interview
 * does not derive. Uses the canonical department mapping, so multi-membership and ended-grant
 * semantics match admission management. A plain department member sees nothing.
 */
export const admissionOutcomePermission = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): "Denied" | "Decide" => {
  const decision = mapOrganizationAuthorityToDepartmentActor(
    authority,
    "admissions.outcomes",
    departmentId,
  );

  return Predicate.isTagged(decision, "Deny") || Predicate.isTagged(decision.value, "Member")
    ? "Denied"
    : "Decide";
};

/** The school coordinator of the department, who holds `placements.coordinate`, announces. */
export const canAnnounceAdmissionOutcome = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): boolean => canManagePlacements(authority, departmentId);
