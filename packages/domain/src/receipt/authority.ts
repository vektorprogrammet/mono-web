import { Effect, Schema } from "effect";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import { DepartmentId, PersonId } from "../organization/schema.js";
import { compareRfc3339Instants, Rfc3339InstantSchema } from "../time.js";
import {
  AmbiguousReceiptPaymentAuthority,
  ReceiptAuthorityDenied,
  type ReceiptAuthorityMappingError,
} from "./errors.js";
import { ReceiptActorSchema, type ReceiptActor } from "./schema.js";

const NonEmpty = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0, { message: "a non-empty string" }),
  ),
);
const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const ReceiptPaymentAuthorityId = NonEmpty.pipe(Schema.brand("ReceiptPaymentAuthorityId"));
export type ReceiptPaymentAuthorityId = typeof ReceiptPaymentAuthorityId.Type;

export const ReceiptApprovalGrantId = NonEmpty.pipe(Schema.brand("ReceiptApprovalGrantId"));
export type ReceiptApprovalGrantId = typeof ReceiptApprovalGrantId.Type;

export const ReceiptAuthorityInstantSchema = Rfc3339InstantSchema;
export type ReceiptAuthorityInstant = typeof ReceiptAuthorityInstantSchema.Type;

export const ReceiptApprovalGrantScopeSchema = Schema.TaggedUnion({
  Department: { departmentId: DepartmentId },
  Global: {},
});
export type ReceiptApprovalGrantScope = typeof ReceiptApprovalGrantScopeSchema.Type;

const ReceiptPaymentAuthorityFields = {
  paymentAuthorityId: ReceiptPaymentAuthorityId,
  personId: PersonId,
  departmentId: DepartmentId,
  paymentAccountCiphertext: NonEmpty,
  startAt: ReceiptAuthorityInstantSchema,
  endAt: Schema.NullOr(ReceiptAuthorityInstantSchema),
  revision: Revision,
} as const;

const ReceiptApprovalGrantFields = {
  approvalGrantId: ReceiptApprovalGrantId,
  personId: PersonId,
  scope: ReceiptApprovalGrantScopeSchema,
  startAt: ReceiptAuthorityInstantSchema,
  endAt: Schema.NullOr(ReceiptAuthorityInstantSchema),
  revision: Revision,
} as const;

const orderedAuthorityInterval = Schema.makeFilter(
  (authority: { readonly startAt: string; readonly endAt: string | null }) =>
    authority.endAt === null || compareRfc3339Instants(authority.endAt, authority.startAt) > 0,
  { message: "a half-open Receipt authority interval" },
);

export const ReceiptPaymentAuthoritySchema = Schema.Struct(ReceiptPaymentAuthorityFields).pipe(
  Schema.check(orderedAuthorityInterval),
);
export type ReceiptPaymentAuthority = typeof ReceiptPaymentAuthoritySchema.Type;

export const ReceiptApprovalGrantSchema = Schema.Struct(ReceiptApprovalGrantFields).pipe(
  Schema.check(orderedAuthorityInterval),
);
export type ReceiptApprovalGrant = typeof ReceiptApprovalGrantSchema.Type;

export const ResolvedReceiptPaymentAuthoritySchema = Schema.Struct({
  ...ReceiptPaymentAuthorityFields,
  active: Schema.Boolean,
}).pipe(Schema.check(orderedAuthorityInterval));
export type ResolvedReceiptPaymentAuthority = typeof ResolvedReceiptPaymentAuthoritySchema.Type;

export const ResolvedReceiptApprovalGrantSchema = Schema.Struct({
  ...ReceiptApprovalGrantFields,
  active: Schema.Boolean,
}).pipe(Schema.check(orderedAuthorityInterval));
export type ResolvedReceiptApprovalGrant = typeof ResolvedReceiptApprovalGrantSchema.Type;

export const ReceiptOrganizationAuthorityStatusSchema = Schema.Literals([
  "Active",
  "Inactive",
  "Absent",
]);
export type ReceiptOrganizationAuthorityStatus =
  typeof ReceiptOrganizationAuthorityStatusSchema.Type;

export const ReceiptAuthoritySchema = Schema.Struct({
  personId: PersonId,
  evaluatedAt: ReceiptAuthorityInstantSchema,
  organizationAuthority: ReceiptOrganizationAuthorityStatusSchema,
  paymentAuthorities: Schema.Array(ResolvedReceiptPaymentAuthoritySchema),
  approvalGrants: Schema.Array(ResolvedReceiptApprovalGrantSchema),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (authority) =>
        authority.paymentAuthorities.every((payment) => payment.personId === authority.personId) &&
        authority.approvalGrants.every((grant) => grant.personId === authority.personId),
      { message: "Receipt authority records for the projected person" },
    ),
  ),
);
export type ReceiptAuthority = typeof ReceiptAuthoritySchema.Type;

export const ReceiptSubmissionPrincipalSchema = Schema.Struct({
  actor: ReceiptActorSchema,
  paymentAccountCiphertext: NonEmpty,
});
export type ReceiptSubmissionPrincipal = typeof ReceiptSubmissionPrincipalSchema.Type;

export const ReceiptOwnerPrincipalSchema = Schema.Struct({
  personId: PersonId,
  active: Schema.Boolean,
});
export type ReceiptOwnerPrincipal = typeof ReceiptOwnerPrincipalSchema.Type;

const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0;

const intervalContains = (
  authority: { readonly startAt: string; readonly endAt: string | null },
  instant: string,
): boolean =>
  compareRfc3339Instants(authority.startAt, instant) <= 0 &&
  (authority.endAt === null || compareRfc3339Instants(instant, authority.endAt) < 0);

const organizationStatus = (
  authority: OrganizationPersonAuthority,
): ReceiptOrganizationAuthorityStatus => {
  if (
    authority.globalAdministrator === "Active" ||
    authority.memberships.some((membership) => membership.active)
  ) {
    return "Active";
  }
  return authority.globalAdministrator === "Inactive" || authority.memberships.length > 0
    ? "Inactive"
    : "Absent";
};

const activeOrganizationAuthorityInDepartment = (
  authority: OrganizationPersonAuthority,
  departmentId: DepartmentId,
): boolean =>
  authority.globalAdministrator === "Active" ||
  authority.memberships.some(
    (membership) => membership.active && membership.departmentId === departmentId,
  );

/** Combines canonical Economy records with one same-instant Organization projection. */
export const projectReceiptAuthority = (
  organization: OrganizationPersonAuthority,
  paymentAuthorities: ReadonlyArray<ReceiptPaymentAuthority>,
  approvalGrants: ReadonlyArray<ReceiptApprovalGrant>,
): ReceiptAuthority => {
  const projectedPayments: Array<ResolvedReceiptPaymentAuthority> = [];
  for (const authority of paymentAuthorities) {
    if (authority.personId !== organization.personId) continue;
    projectedPayments.push({
      ...authority,
      active:
        intervalContains(authority, organization.evaluatedAt) &&
        activeOrganizationAuthorityInDepartment(organization, authority.departmentId),
    });
  }
  projectedPayments.sort(
    (left, right) =>
      compareText(left.departmentId, right.departmentId) ||
      compareRfc3339Instants(left.startAt, right.startAt) ||
      compareText(left.paymentAuthorityId, right.paymentAuthorityId),
  );

  const resolvedOrganizationStatus = organizationStatus(organization);
  const projectedGrants: Array<ResolvedReceiptApprovalGrant> = [];
  for (const grant of approvalGrants) {
    if (grant.personId !== organization.personId) continue;
    projectedGrants.push({
      ...grant,
      active:
        intervalContains(grant, organization.evaluatedAt) &&
        (grant.scope._tag === "Global"
          ? resolvedOrganizationStatus === "Active"
          : activeOrganizationAuthorityInDepartment(organization, grant.scope.departmentId)),
    });
  }
  projectedGrants.sort(
    (left, right) =>
      compareText(left.scope._tag, right.scope._tag) ||
      compareText(
        left.scope._tag === "Department" ? left.scope.departmentId : "",
        right.scope._tag === "Department" ? right.scope.departmentId : "",
      ) ||
      compareRfc3339Instants(left.startAt, right.startAt) ||
      compareText(left.approvalGrantId, right.approvalGrantId),
  );

  return {
    personId: organization.personId,
    evaluatedAt: organization.evaluatedAt,
    organizationAuthority: resolvedOrganizationStatus,
    paymentAuthorities: projectedPayments,
    approvalGrants: projectedGrants,
  };
};

type TemporalAuthority = {
  readonly startAt: string;
  readonly endAt: string | null;
};

const temporalCandidateKind = (authority: TemporalAuthority, instant: string): 0 | 1 | 2 => {
  if (intervalContains(authority, instant)) return 0;
  return compareRfc3339Instants(authority.startAt, instant) <= 0 ? 1 : 2;
};

const preferTemporalCandidate = <A extends TemporalAuthority>(
  current: A | undefined,
  candidate: A,
  instant: string,
): A => {
  if (current === undefined) return candidate;
  const currentKind = temporalCandidateKind(current, instant);
  const candidateKind = temporalCandidateKind(candidate, instant);
  if (candidateKind < currentKind) return candidate;
  if (candidateKind > currentKind || candidateKind === 0) return current;
  const starts = compareRfc3339Instants(candidate.startAt, current.startAt);
  return candidateKind === 1
    ? starts > 0
      ? candidate
      : current
    : starts < 0
      ? candidate
      : current;
};

const deny = (
  authority: ReceiptAuthority,
  operation: "Submission" | "DepartmentApproval" | "GlobalApproval" | "Owner",
  departmentId: DepartmentId | null,
): ReceiptAuthorityDenied =>
  new ReceiptAuthorityDenied({ personId: authority.personId, operation, departmentId });

const ambiguousPayment = (
  authority: ReceiptAuthority,
  payments: ReadonlyArray<ResolvedReceiptPaymentAuthority>,
): AmbiguousReceiptPaymentAuthority =>
  new AmbiguousReceiptPaymentAuthority({
    personId: authority.personId,
    departmentIds: payments
      .map((payment) => payment.departmentId)
      .sort((left, right) => compareText(left, right)),
  });

export const mapReceiptSubmissionPrincipal = (
  authority: ReceiptAuthority,
  departmentId?: DepartmentId,
): Effect.Effect<ReceiptSubmissionPrincipal, ReceiptAuthorityMappingError> => {
  const candidatesByDepartment = new Map<DepartmentId, ResolvedReceiptPaymentAuthority>();
  for (const payment of authority.paymentAuthorities) {
    candidatesByDepartment.set(
      payment.departmentId,
      preferTemporalCandidate(
        candidatesByDepartment.get(payment.departmentId),
        payment,
        authority.evaluatedAt,
      ),
    );
  }

  let selected: ResolvedReceiptPaymentAuthority | undefined;
  if (departmentId !== undefined) {
    selected = candidatesByDepartment.get(departmentId);
  } else {
    const candidates = Array.from(candidatesByDepartment.values());
    const active = candidates.filter((payment) => payment.active);
    if (active.length > 1) return Effect.fail(ambiguousPayment(authority, active));
    if (active.length === 1) {
      selected = active[0];
    } else {
      if (candidates.length > 1) {
        return Effect.fail(ambiguousPayment(authority, candidates));
      }
      selected = candidates[0];
    }
  }

  if (selected === undefined) {
    return Effect.fail(deny(authority, "Submission", departmentId ?? null));
  }
  return Effect.succeed({
    actor: {
      personId: authority.personId,
      departmentId: selected.departmentId,
      active: selected.active,
      approvalScope: { _tag: "None" },
    },
    paymentAccountCiphertext: selected.paymentAccountCiphertext,
  });
};

export const mapReceiptDepartmentApprovalActor = (
  authority: ReceiptAuthority,
  departmentId: DepartmentId,
): Effect.Effect<ReceiptActor, ReceiptAuthorityDenied> => {
  let selected: ResolvedReceiptApprovalGrant | undefined;
  for (const grant of authority.approvalGrants) {
    if (grant.scope._tag !== "Department" || grant.scope.departmentId !== departmentId) continue;
    selected = preferTemporalCandidate(selected, grant, authority.evaluatedAt);
  }
  if (selected === undefined) {
    return Effect.fail(deny(authority, "DepartmentApproval", departmentId));
  }
  return Effect.succeed({
    personId: authority.personId,
    departmentId,
    active: selected.active,
    approvalScope: { _tag: "Department", departmentId },
  });
};

export const mapReceiptGlobalApprovalActor = (
  authority: ReceiptAuthority,
  receiptDepartmentId: DepartmentId,
): Effect.Effect<ReceiptActor, ReceiptAuthorityDenied> => {
  let selected: ResolvedReceiptApprovalGrant | undefined;
  for (const grant of authority.approvalGrants) {
    if (grant.scope._tag !== "Global") continue;
    selected = preferTemporalCandidate(selected, grant, authority.evaluatedAt);
  }
  if (selected === undefined) {
    return Effect.fail(deny(authority, "GlobalApproval", receiptDepartmentId));
  }
  return Effect.succeed({
    personId: authority.personId,
    departmentId: receiptDepartmentId,
    active: selected.active,
    approvalScope: { _tag: "Global" },
  });
};

/** Owner lists use this person-keyed result and never select one department. */
export const mapReceiptOwnerPrincipal = (
  authority: ReceiptAuthority,
): Effect.Effect<ReceiptOwnerPrincipal, ReceiptAuthorityDenied> =>
  authority.organizationAuthority === "Absent"
    ? Effect.fail(deny(authority, "Owner", null))
    : Effect.succeed({
        personId: authority.personId,
        active: authority.organizationAuthority === "Active",
      });

/** Existing receipt transitions supply the receipt's immutable department. */
export const mapReceiptOwnerActor = (
  authority: ReceiptAuthority,
  receiptDepartmentId: DepartmentId,
): Effect.Effect<ReceiptActor, ReceiptAuthorityDenied> =>
  mapReceiptOwnerPrincipal(authority).pipe(
    Effect.map((principal) => ({
      personId: principal.personId,
      departmentId: receiptDepartmentId,
      active: principal.active,
      approvalScope: { _tag: "None" as const },
    })),
  );
