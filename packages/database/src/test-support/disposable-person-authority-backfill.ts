/**
 * Disposable test-data adapter for pre-config, JSON-decoded legacy token maps.
 *
 * This module is intentionally outside the database package exports. Token-map
 * keys are discarded during decoding and never enter a plan, result, error, or
 * SQL statement.
 */
import { Rfc3339InstantSchema } from "@vektorprogrammet/domain/admission-period";
import { Database, type DatabaseShape } from "@vektorprogrammet/domain/database";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { DepartmentId, PersonId } from "@vektorprogrammet/domain/organization";
import { DateTime, Effect, Schema } from "effect";

const NonEmptyText = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const AdmissionToken = NonEmptyText;
const ReceiptToken = NonEmptyText;
const OrganizationToken = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.length > 0 && value.length <= 512 && !/\s/u.test(value), {
      message: "a bounded bearer token",
    }),
  ),
);

const AdmissionActorSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literals(["DepartmentLeader"]),
    personId: PersonId,
    departmentId: DepartmentId,
    active: Schema.Boolean,
  }),
  Schema.Struct({
    _tag: Schema.Literals(["GlobalAdmin"]),
    personId: PersonId,
    active: Schema.Boolean,
  }),
  Schema.Struct({
    _tag: Schema.Literals(["Member"]),
    personId: PersonId,
    departmentId: DepartmentId,
    active: Schema.Boolean,
  }),
]);
const AdmissionPrincipalSchema = Schema.Union([
  AdmissionActorSchema,
  Schema.Struct({ actor: AdmissionActorSchema }),
]);
const OrganizationActorSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literals(["OrganizationAdministrator"]),
    personId: PersonId,
  }),
  Schema.Struct({
    _tag: Schema.Literals(["OrganizationMember"]),
    personId: PersonId,
  }),
]);
const ReceiptApprovalScopeSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literals(["None"]) }),
  Schema.Struct({ _tag: Schema.Literals(["Global"]) }),
  Schema.Struct({
    _tag: Schema.Literals(["Department"]),
    departmentId: DepartmentId,
  }),
]);
const ReceiptPrincipalSchema = Schema.Struct({
  personId: PersonId,
  departmentId: DepartmentId,
  active: Schema.Boolean,
  approvalScope: ReceiptApprovalScopeSchema,
  paymentAccountCiphertext: NonEmptyText,
});

/** Only pre-config, JSON-decoded plain records are accepted. */
export const DisposablePreConfigPersonAuthorityEvidenceSchema = Schema.Struct({
  evaluatedAt: Rfc3339InstantSchema,
  authorityStartAt: Rfc3339InstantSchema,
  admission: Schema.Record(AdmissionToken, AdmissionPrincipalSchema),
  organization: Schema.Record(OrganizationToken, OrganizationActorSchema),
  receipt: Schema.Record(ReceiptToken, ReceiptPrincipalSchema),
});
export type DisposablePreConfigPersonAuthorityEvidence =
  typeof DisposablePreConfigPersonAuthorityEvidenceSchema.Type;

export class DisposableAuthorityEvidenceNondeterministicInput extends Schema.TaggedError<DisposableAuthorityEvidenceNondeterministicInput>()(
  "DisposableAuthorityEvidenceNondeterministicInput",
  { message: NonEmptyText },
) {}

export class DisposableAuthorityEvidenceDecodeError extends Schema.TaggedError<DisposableAuthorityEvidenceDecodeError>()(
  "DisposableAuthorityEvidenceDecodeError",
  { message: NonEmptyText },
) {}

export class DisposableAuthorityEvidenceConflict extends Schema.TaggedError<DisposableAuthorityEvidenceConflict>()(
  "DisposableAuthorityEvidenceConflict",
  { factKey: NonEmptyText, message: NonEmptyText },
) {}

export class DisposableAuthorityEvidenceAmbiguousDuplicate extends Schema.TaggedError<DisposableAuthorityEvidenceAmbiguousDuplicate>()(
  "DisposableAuthorityEvidenceAmbiguousDuplicate",
  { factKey: NonEmptyText, message: NonEmptyText },
) {}

export class DisposableAuthorityEvidenceMissingReference extends Schema.TaggedError<DisposableAuthorityEvidenceMissingReference>()(
  "DisposableAuthorityEvidenceMissingReference",
  {
    referenceKind: Schema.Literals(["Person", "Department", "Membership", "PaymentAuthority"]),
    personId: NonEmptyText,
    referenceId: NonEmptyText,
  },
) {}

export class DisposableAuthorityEvidencePersistenceError extends Schema.TaggedError<DisposableAuthorityEvidencePersistenceError>()(
  "DisposableAuthorityEvidencePersistenceError",
  { operation: NonEmptyText, message: NonEmptyText },
) {}

export type DisposableAuthorityEvidenceFailure =
  | DisposableAuthorityEvidenceNondeterministicInput
  | DisposableAuthorityEvidenceDecodeError
  | DisposableAuthorityEvidenceConflict
  | DisposableAuthorityEvidenceAmbiguousDuplicate
  | DisposableAuthorityEvidenceMissingReference
  | DisposableAuthorityEvidencePersistenceError;

export interface DisposablePersonAuthorityBackfillResult {
  readonly personIds: ReadonlyArray<string>;
  readonly verifiedMembershipIds: ReadonlyArray<string>;
  readonly globalAdministratorGrantIds: ReadonlyArray<string>;
  readonly receiptPaymentAuthorityIds: ReadonlyArray<string>;
  readonly receiptApprovalGrantIds: ReadonlyArray<string>;
}

type AdmissionActor = typeof AdmissionActorSchema.Type;

interface AdmissionDepartmentFact {
  readonly personId: string;
  readonly departmentId: string;
  readonly role: "DepartmentLeader" | "Member";
  readonly active: boolean;
}

interface AdmissionGlobalFact {
  readonly personId: string;
  readonly active: boolean;
}

interface OrganizationFact {
  readonly personId: string;
  readonly role: "OrganizationAdministrator" | "OrganizationMember";
}

interface ReceiptPaymentFact {
  readonly personId: string;
  readonly departmentId: string;
  readonly active: boolean;
  readonly paymentAccountCiphertext: string;
}

type ReceiptApprovalFact =
  | {
      readonly personId: string;
      readonly scope: "Department";
      readonly departmentId: string;
      readonly active: boolean;
    }
  | {
      readonly personId: string;
      readonly scope: "Global";
      readonly departmentId: null;
      readonly active: boolean;
    };

interface GlobalAdministratorGrantRow {
  readonly grantId: string;
  readonly personId: string;
  readonly startAt: string;
  readonly endAt: string | null;
}

interface ReceiptPaymentAuthorityRow {
  readonly authorityId: string;
  readonly personId: string;
  readonly departmentId: string;
  readonly paymentAccountCiphertext: string;
  readonly startAt: string;
  readonly endAt: string | null;
}

interface ReceiptApprovalGrantRow {
  readonly grantId: string;
  readonly personId: string;
  readonly scope: "Department" | "Global";
  readonly departmentId: string | null;
  readonly startAt: string;
  readonly endAt: string | null;
}

interface PersonEvidenceGroup {
  readonly personId: string;
  readonly admissionDepartments: Array<AdmissionDepartmentFact>;
  admissionGlobal?: AdmissionGlobalFact;
  organization?: OrganizationFact;
  readonly payments: Array<ReceiptPaymentFact>;
  readonly approvals: Array<ReceiptApprovalFact>;
  administratorGrant?: GlobalAdministratorGrantRow;
}

interface MembershipEvidenceRow {
  readonly membershipId: string;
  readonly teamId: string;
  readonly departmentId: string;
  readonly active: boolean;
  readonly teamLeader: boolean;
}

interface ExistsRow {
  readonly exists: boolean;
}

interface AdministratorStatusRow {
  readonly known: boolean;
  readonly active: boolean;
}

interface ExistingAuthorityOverlapRow {
  readonly sameId: boolean;
  readonly sameFact: boolean;
}

const compareText = (left: string, right: string): -1 | 0 | 1 =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizedInstant = (value: string): string => DateTime.formatIso(DateTime.makeUnsafe(value));

const instantMillis = (value: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(value));

const isDeterministicJsonValue = (input: unknown, ancestors = new WeakSet<object>()): boolean => {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return true;
  }
  if (typeof input !== "object" || Array.isArray(input)) return false;
  try {
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (ancestors.has(input)) return false;
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (!keys.every((key): key is string => typeof key === "string")) return false;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isDeterministicJsonValue(descriptor.value, ancestors)
      ) {
        return false;
      }
    }
    ancestors.delete(input);
    return true;
  } catch {
    return false;
  }
};

const stableAuthorityId = (prefix: string, fact: unknown): string =>
  `${prefix}_${sha256Hex(canonicalJsonBytes({ specification: "0055", authority: fact }))}`;

const consolidateFacts = <A>(
  facts: ReadonlyArray<A>,
  identityOf: (fact: A) => string,
  valueOf: (fact: A) => string,
): Effect.Effect<ReadonlyArray<A>, DisposableAuthorityEvidenceConflict> =>
  Effect.gen(function* () {
    const byIdentity = new Map<string, A>();
    const ordered = [...facts].sort((left, right) =>
      compareText(canonicalJson(left), canonicalJson(right)),
    );
    for (const fact of ordered) {
      const identity = identityOf(fact);
      const existing = byIdentity.get(identity);
      if (existing !== undefined && valueOf(existing) !== valueOf(fact)) {
        return yield* Effect.fail(
          new DisposableAuthorityEvidenceConflict({
            factKey: identity,
            message: "legacy token evidence contains conflicting authority facts",
          }),
        );
      }
      if (existing === undefined) byIdentity.set(identity, fact);
    }
    return [...byIdentity.values()].sort((left, right) =>
      compareText(identityOf(left), identityOf(right)),
    );
  });

const admissionActor = (
  principal: DisposablePreConfigPersonAuthorityEvidence["admission"][string],
): AdmissionActor => ("actor" in principal ? principal.actor : principal);

const intervalFor = (
  active: boolean,
  authorityStartAt: string,
  evaluatedAt: string,
): { readonly startAt: string; readonly endAt: string | null } => ({
  startAt: authorityStartAt,
  endAt: active ? null : evaluatedAt,
});

const decodeAndPlan = (
  input: unknown,
): Effect.Effect<
  {
    readonly evaluatedAt: string;
    readonly groups: ReadonlyArray<PersonEvidenceGroup>;
    readonly administratorGrants: ReadonlyArray<GlobalAdministratorGrantRow>;
    readonly paymentAuthorities: ReadonlyArray<ReceiptPaymentAuthorityRow>;
    readonly approvalGrants: ReadonlyArray<ReceiptApprovalGrantRow>;
  },
  | DisposableAuthorityEvidenceNondeterministicInput
  | DisposableAuthorityEvidenceDecodeError
  | DisposableAuthorityEvidenceConflict
> =>
  Effect.gen(function* () {
    if (!isDeterministicJsonValue(input)) {
      return yield* Effect.fail(
        new DisposableAuthorityEvidenceNondeterministicInput({
          message: "evidence must be an acyclic plain JSON object with data properties",
        }),
      );
    }
    const evidence = yield* Schema.decodeUnknownEffect(
      DisposablePreConfigPersonAuthorityEvidenceSchema,
    )(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError(
        () =>
          new DisposableAuthorityEvidenceDecodeError({
            message: "invalid pre-config person-authority token-map evidence",
          }),
      ),
    );

    const admissions = Object.values(evidence.admission).map(admissionActor);
    const organizations = Object.values(evidence.organization);
    const receipts = Object.values(evidence.receipt);
    const hasInactiveFact =
      admissions.some((actor) => actor.active === false) ||
      receipts.some((principal) => principal.active === false);
    const startMillis = instantMillis(evidence.authorityStartAt);
    const evaluatedMillis = instantMillis(evidence.evaluatedAt);
    if (startMillis > evaluatedMillis || (hasInactiveFact && startMillis === evaluatedMillis)) {
      return yield* Effect.fail(
        new DisposableAuthorityEvidenceDecodeError({
          message:
            "authorityStartAt must not follow evaluatedAt and must precede it for inactive evidence",
        }),
      );
    }
    const authorityStartAt = normalizedInstant(evidence.authorityStartAt);
    const evaluatedAt = normalizedInstant(evidence.evaluatedAt);

    const admissionDepartmentFacts = yield* consolidateFacts(
      admissions.flatMap(
        (actor): ReadonlyArray<AdmissionDepartmentFact> =>
          actor._tag === "GlobalAdmin"
            ? []
            : [
                {
                  personId: actor.personId,
                  departmentId: actor.departmentId,
                  role: actor._tag,
                  active: actor.active,
                },
              ],
      ),
      (fact) =>
        canonicalJson({
          kind: "AdmissionDepartmentAuthority",
          personId: fact.personId,
          departmentId: fact.departmentId,
        }),
      (fact) => canonicalJson({ role: fact.role, active: fact.active }),
    );
    const admissionGlobalFacts = yield* consolidateFacts(
      admissions.flatMap(
        (actor): ReadonlyArray<AdmissionGlobalFact> =>
          actor._tag === "GlobalAdmin" ? [{ personId: actor.personId, active: actor.active }] : [],
      ),
      (fact) => canonicalJson({ kind: "GlobalAdministrator", personId: fact.personId }),
      (fact) => canonicalJson({ active: fact.active }),
    );
    const organizationFacts = yield* consolidateFacts(
      organizations.map(
        (actor): OrganizationFact => ({ personId: actor.personId, role: actor._tag }),
      ),
      (fact) => canonicalJson({ kind: "OrganizationActor", personId: fact.personId }),
      (fact) => canonicalJson({ role: fact.role }),
    );
    const paymentFacts = yield* consolidateFacts(
      receipts.map(
        (principal): ReceiptPaymentFact => ({
          personId: principal.personId,
          departmentId: principal.departmentId,
          active: principal.active,
          paymentAccountCiphertext: principal.paymentAccountCiphertext,
        }),
      ),
      (fact) =>
        canonicalJson({
          kind: "ReceiptPaymentAuthority",
          personId: fact.personId,
          departmentId: fact.departmentId,
        }),
      (fact) =>
        canonicalJson({
          active: fact.active,
          paymentAccountCiphertext: fact.paymentAccountCiphertext,
        }),
    );
    const approvalFacts = yield* consolidateFacts(
      receipts.flatMap((principal): ReadonlyArray<ReceiptApprovalFact> => {
        if (principal.approvalScope._tag === "None") return [];
        if (principal.approvalScope._tag === "Department") {
          return [
            {
              personId: principal.personId,
              scope: "Department",
              departmentId: principal.approvalScope.departmentId,
              active: principal.active,
            },
          ];
        }
        return [
          {
            personId: principal.personId,
            scope: "Global",
            departmentId: null,
            active: principal.active,
          },
        ];
      }),
      (fact) =>
        canonicalJson({
          kind: "ReceiptApprovalGrant",
          personId: fact.personId,
          scope: fact.scope,
          departmentId: fact.departmentId,
        }),
      (fact) => canonicalJson({ active: fact.active }),
    );
    const administratorFacts = yield* consolidateFacts(
      [
        ...admissionGlobalFacts,
        ...organizationFacts.flatMap(
          (fact): ReadonlyArray<AdmissionGlobalFact> =>
            fact.role === "OrganizationAdministrator"
              ? [{ personId: fact.personId, active: true }]
              : [],
        ),
      ],
      (fact) => canonicalJson({ kind: "GlobalAdministrator", personId: fact.personId }),
      (fact) => canonicalJson({ active: fact.active }),
    );

    const administratorGrants = administratorFacts.map((fact) => {
      const interval = intervalFor(fact.active, authorityStartAt, evaluatedAt);
      return {
        grantId: stableAuthorityId("organization_global_administrator_grant", {
          personId: fact.personId,
          ...interval,
        }),
        personId: fact.personId,
        ...interval,
      };
    });
    const paymentAuthorities = paymentFacts.map((fact) => {
      const interval = intervalFor(fact.active, authorityStartAt, evaluatedAt);
      return {
        authorityId: stableAuthorityId("economy_receipt_payment_authority", {
          personId: fact.personId,
          departmentId: fact.departmentId,
          ...interval,
        }),
        personId: fact.personId,
        departmentId: fact.departmentId,
        paymentAccountCiphertext: fact.paymentAccountCiphertext,
        ...interval,
      };
    });
    const approvalGrants = approvalFacts.map((fact) => {
      const interval = intervalFor(fact.active, authorityStartAt, evaluatedAt);
      return {
        grantId: stableAuthorityId("economy_receipt_approval_grant", {
          personId: fact.personId,
          scope: fact.scope,
          departmentId: fact.departmentId,
          ...interval,
        }),
        personId: fact.personId,
        scope: fact.scope,
        departmentId: fact.departmentId,
        ...interval,
      };
    });

    const groupsByPerson = new Map<string, PersonEvidenceGroup>();
    const group = (personId: string): PersonEvidenceGroup => {
      const existing = groupsByPerson.get(personId);
      if (existing !== undefined) return existing;
      const created: PersonEvidenceGroup = {
        personId,
        admissionDepartments: [],
        payments: [],
        approvals: [],
      };
      groupsByPerson.set(personId, created);
      return created;
    };
    for (const fact of admissionDepartmentFacts)
      group(fact.personId).admissionDepartments.push(fact);
    for (const fact of admissionGlobalFacts) group(fact.personId).admissionGlobal = fact;
    for (const fact of organizationFacts) group(fact.personId).organization = fact;
    for (const fact of paymentFacts) group(fact.personId).payments.push(fact);
    for (const fact of approvalFacts) group(fact.personId).approvals.push(fact);
    for (const grant of administratorGrants) group(grant.personId).administratorGrant = grant;

    return {
      evaluatedAt,
      groups: [...groupsByPerson.values()].sort((left, right) =>
        compareText(left.personId, right.personId),
      ),
      administratorGrants: [...administratorGrants].sort((left, right) =>
        compareText(left.grantId, right.grantId),
      ),
      paymentAuthorities: [...paymentAuthorities].sort((left, right) =>
        compareText(left.authorityId, right.authorityId),
      ),
      approvalGrants: [...approvalGrants].sort((left, right) =>
        compareText(left.grantId, right.grantId),
      ),
    };
  });

const personExists = (sql: DatabaseShape, personId: string) =>
  sql<ExistsRow>`
    SELECT EXISTS (
      SELECT 1 FROM person_profiles WHERE person_id = ${personId}
    ) AS "exists"
  `.pipe(Effect.map((rows) => rows[0]?.exists === true));

const departmentExists = (sql: DatabaseShape, departmentId: string) =>
  sql<ExistsRow>`
    SELECT EXISTS (
      SELECT 1 FROM organization_departments WHERE department_id = ${departmentId}
    ) AS "exists"
  `.pipe(Effect.map((rows) => rows[0]?.exists === true));

const readMembershipEvidence = (sql: DatabaseShape, personId: string, evaluatedAt: string) =>
  sql<MembershipEvidenceRow>`
    SELECT
      membership.membership_id AS "membershipId",
      team.team_id AS "teamId",
      department.department_id AS "departmentId",
      (
        membership.start_at <= ${evaluatedAt}::timestamptz
        AND (membership.end_at IS NULL OR ${evaluatedAt}::timestamptz < membership.end_at)
        AND NOT membership.is_suspended
        AND team.active
        AND department.active
      ) AS "active",
      membership.is_team_leader AS "teamLeader"
    FROM organization_memberships AS membership
    INNER JOIN organization_teams AS team ON team.team_id = membership.team_id
    INNER JOIN organization_departments AS department
      ON department.department_id = team.department_id
    WHERE membership.person_id = ${personId}
    ORDER BY department.department_id, team.team_id, membership.membership_id
  `;

const readAdministratorStatus = (sql: DatabaseShape, personId: string, evaluatedAt: string) =>
  sql<AdministratorStatusRow>`
    SELECT
      EXISTS (
        SELECT 1
        FROM organization_global_administrator_grants
        WHERE person_id = ${personId}
      ) AS "known",
      EXISTS (
        SELECT 1
        FROM organization_global_administrator_grants
        WHERE person_id = ${personId}
          AND start_at <= ${evaluatedAt}::timestamptz
          AND (end_at IS NULL OR ${evaluatedAt}::timestamptz < end_at)
      ) AS "active"
  `.pipe(
    Effect.map(
      (rows) => rows[0] ?? ({ known: false, active: false } satisfies AdministratorStatusRow),
    ),
  );

const expectedAdmissionDepartmentActor = (
  rows: ReadonlyArray<MembershipEvidenceRow>,
): { readonly role: "DepartmentLeader" | "Member"; readonly active: boolean } => {
  const activeLeader = rows.some((row) => row.active && row.teamLeader);
  if (activeLeader) return { role: "DepartmentLeader", active: true };
  const activeMembership = rows.some((row) => row.active);
  const inactiveLeader = rows.some((row) => !row.active && row.teamLeader);
  if (!activeMembership && inactiveLeader) return { role: "DepartmentLeader", active: false };
  return { role: "Member", active: activeMembership };
};

const overlappingAdministratorGrants = (sql: DatabaseShape, row: GlobalAdministratorGrantRow) =>
  sql<ExistingAuthorityOverlapRow>`
    SELECT
      grant_id = ${row.grantId} AS "sameId",
      (
        start_at = ${row.startAt}::timestamptz
        AND end_at IS NOT DISTINCT FROM ${row.endAt}::timestamptz
      ) AS "sameFact"
    FROM organization_global_administrator_grants
    WHERE person_id = ${row.personId}
      AND tstzrange(start_at, end_at, '[)')
        && tstzrange(${row.startAt}::timestamptz, ${row.endAt}::timestamptz, '[)')
    ORDER BY grant_id
  `;

const overlappingPaymentAuthorities = (sql: DatabaseShape, row: ReceiptPaymentAuthorityRow) =>
  sql<ExistingAuthorityOverlapRow>`
    SELECT
      payment_authority_id = ${row.authorityId} AS "sameId",
      (
        payment_account_ciphertext = ${row.paymentAccountCiphertext}
        AND start_at = ${row.startAt}::timestamptz
        AND end_at IS NOT DISTINCT FROM ${row.endAt}::timestamptz
      ) AS "sameFact"
    FROM economy_payment_authorities
    WHERE person_id = ${row.personId}
      AND department_id = ${row.departmentId}
      AND tstzrange(start_at, end_at, '[)')
        && tstzrange(${row.startAt}::timestamptz, ${row.endAt}::timestamptz, '[)')
    ORDER BY payment_authority_id
  `;

const overlappingApprovalGrants = (sql: DatabaseShape, row: ReceiptApprovalGrantRow) =>
  sql<ExistingAuthorityOverlapRow>`
    SELECT
      approval_grant_id = ${row.grantId} AS "sameId",
      (
        start_at = ${row.startAt}::timestamptz
        AND end_at IS NOT DISTINCT FROM ${row.endAt}::timestamptz
      ) AS "sameFact"
    FROM economy_receipt_approval_grants
    WHERE person_id = ${row.personId}
      AND scope = ${row.scope}
      AND department_id IS NOT DISTINCT FROM ${row.departmentId}
      AND tstzrange(start_at, end_at, '[)')
        && tstzrange(${row.startAt}::timestamptz, ${row.endAt}::timestamptz, '[)')
    ORDER BY approval_grant_id
  `;

const insertionRequired = (
  rows: ReadonlyArray<ExistingAuthorityOverlapRow>,
  factKey: string,
): Effect.Effect<
  boolean,
  DisposableAuthorityEvidenceConflict | DisposableAuthorityEvidenceAmbiguousDuplicate
> => {
  const existing = rows[0];
  if (existing === undefined) return Effect.succeed(true);
  if (rows.length === 1 && existing.sameId && existing.sameFact) {
    return Effect.succeed(false);
  }
  if (rows.every((row) => row.sameFact)) {
    return Effect.fail(
      new DisposableAuthorityEvidenceAmbiguousDuplicate({
        factKey,
        message: "an equivalent authority fact already has a different stable identity",
      }),
    );
  }
  return Effect.fail(
    new DisposableAuthorityEvidenceConflict({
      factKey,
      message: "planned authority interval conflicts with an existing authority fact",
    }),
  );
};

const missingReference = (
  referenceKind: "Person" | "Department" | "Membership" | "PaymentAuthority",
  personId: string,
  referenceId: string,
) =>
  new DisposableAuthorityEvidenceMissingReference({
    referenceKind,
    personId,
    referenceId,
  });

const evidenceConflict = (factKey: string, message: string) =>
  new DisposableAuthorityEvidenceConflict({ factKey, message });

/**
 * Backfills disposable authority rows from already JSON-decoded legacy test
 * evidence. The returned Effect requires the repository Database capability.
 */
export const backfillDisposablePersonAuthoritiesFromPreConfigEvidence = (
  input: unknown,
): Effect.Effect<
  DisposablePersonAuthorityBackfillResult,
  DisposableAuthorityEvidenceFailure,
  Database
> =>
  Effect.gen(function* () {
    const plan = yield* decodeAndPlan(input);
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const verifiedMembershipIds = new Set<string>();
          for (const group of plan.groups) {
            if (!(yield* personExists(sql, group.personId))) {
              return yield* Effect.fail(missingReference("Person", group.personId, group.personId));
            }
            const memberships = yield* readMembershipEvidence(
              sql,
              group.personId,
              plan.evaluatedAt,
            );
            const referencedDepartments = new Set<string>();
            for (const fact of group.admissionDepartments) {
              referencedDepartments.add(fact.departmentId);
            }
            for (const fact of group.payments) referencedDepartments.add(fact.departmentId);
            for (const fact of group.approvals) {
              if (fact.departmentId !== null) referencedDepartments.add(fact.departmentId);
            }
            for (const departmentId of [...referencedDepartments].sort(compareText)) {
              if (!(yield* departmentExists(sql, departmentId))) {
                return yield* Effect.fail(
                  missingReference("Department", group.personId, departmentId),
                );
              }
            }

            const storedAdministrator = yield* readAdministratorStatus(
              sql,
              group.personId,
              plan.evaluatedAt,
            );
            const plannedAdministratorKnown = group.administratorGrant !== undefined;
            const plannedAdministratorActive = group.administratorGrant?.endAt === null;
            const administratorKnown = storedAdministrator.known || plannedAdministratorKnown;
            const administratorActive = storedAdministrator.active || plannedAdministratorActive;

            if (group.organization?.role === "OrganizationAdministrator" && !administratorActive) {
              return yield* Effect.fail(
                evidenceConflict(
                  canonicalJson({ kind: "OrganizationActor", personId: group.personId }),
                  "Organization administrator evidence is not active at evaluatedAt",
                ),
              );
            }
            if (group.organization?.role === "OrganizationMember") {
              if (administratorActive) {
                return yield* Effect.fail(
                  evidenceConflict(
                    canonicalJson({ kind: "OrganizationActor", personId: group.personId }),
                    "Organization member evidence conflicts with an active administrator grant",
                  ),
                );
              }
              if (memberships.length === 0) {
                return yield* Effect.fail(
                  missingReference("Membership", group.personId, group.personId),
                );
              }
              for (const membership of memberships) {
                verifiedMembershipIds.add(membership.membershipId);
              }
            }
            if (
              group.admissionGlobal !== undefined &&
              (!administratorKnown || administratorActive !== group.admissionGlobal.active)
            ) {
              return yield* Effect.fail(
                evidenceConflict(
                  canonicalJson({ kind: "GlobalAdministrator", personId: group.personId }),
                  "Admission global-administrator evidence conflicts with canonical grant state",
                ),
              );
            }
            for (const fact of group.admissionDepartments) {
              if (administratorKnown) {
                return yield* Effect.fail(
                  evidenceConflict(
                    canonicalJson({
                      kind: "AdmissionDepartmentAuthority",
                      personId: fact.personId,
                      departmentId: fact.departmentId,
                    }),
                    "department actor evidence conflicts with canonical administrator state",
                  ),
                );
              }
              const departmentMemberships = memberships.filter(
                (membership) => membership.departmentId === fact.departmentId,
              );
              if (departmentMemberships.length === 0) {
                return yield* Effect.fail(
                  missingReference("Membership", fact.personId, fact.departmentId),
                );
              }
              const expected = expectedAdmissionDepartmentActor(departmentMemberships);
              if (expected.role !== fact.role || expected.active !== fact.active) {
                return yield* Effect.fail(
                  evidenceConflict(
                    canonicalJson({
                      kind: "AdmissionDepartmentAuthority",
                      personId: fact.personId,
                      departmentId: fact.departmentId,
                    }),
                    "Admission actor evidence conflicts with canonical membership facts",
                  ),
                );
              }
              for (const membership of departmentMemberships) {
                verifiedMembershipIds.add(membership.membershipId);
              }
            }
            for (const payment of group.payments) {
              const departmentMemberships = memberships.filter(
                (membership) => membership.departmentId === payment.departmentId,
              );
              if (departmentMemberships.length === 0) {
                return yield* Effect.fail(
                  missingReference("Membership", payment.personId, payment.departmentId),
                );
              }
              if (
                payment.active &&
                !departmentMemberships.some((membership) => membership.active)
              ) {
                return yield* Effect.fail(
                  evidenceConflict(
                    canonicalJson({
                      kind: "ReceiptPaymentAuthority",
                      personId: payment.personId,
                      departmentId: payment.departmentId,
                    }),
                    "active payment evidence lacks active Organization authority",
                  ),
                );
              }
              for (const membership of departmentMemberships) {
                verifiedMembershipIds.add(membership.membershipId);
              }
            }
            for (const approval of group.approvals) {
              if (group.payments.length === 0) {
                return yield* Effect.fail(
                  missingReference("PaymentAuthority", approval.personId, approval.personId),
                );
              }
              if (approval.scope === "Department") {
                const departmentMemberships = memberships.filter(
                  (membership) => membership.departmentId === approval.departmentId,
                );
                if (departmentMemberships.length === 0) {
                  return yield* Effect.fail(
                    missingReference("Membership", approval.personId, approval.departmentId),
                  );
                }
                if (
                  approval.active &&
                  !departmentMemberships.some((membership) => membership.active)
                ) {
                  return yield* Effect.fail(
                    evidenceConflict(
                      canonicalJson({
                        kind: "ReceiptApprovalGrant",
                        personId: approval.personId,
                        scope: approval.scope,
                        departmentId: approval.departmentId,
                      }),
                      "active department approval evidence lacks active Organization authority",
                    ),
                  );
                }
                for (const membership of departmentMemberships) {
                  verifiedMembershipIds.add(membership.membershipId);
                }
              } else if (
                approval.active &&
                !administratorActive &&
                !memberships.some((membership) => membership.active)
              ) {
                return yield* Effect.fail(
                  evidenceConflict(
                    canonicalJson({
                      kind: "ReceiptApprovalGrant",
                      personId: approval.personId,
                      scope: approval.scope,
                    }),
                    "active global approval evidence lacks active Organization authority",
                  ),
                );
              }
            }
          }

          const administratorInserts: Array<GlobalAdministratorGrantRow> = [];
          for (const row of plan.administratorGrants) {
            const insert = yield* insertionRequired(
              yield* overlappingAdministratorGrants(sql, row),
              canonicalJson({ kind: "GlobalAdministrator", personId: row.personId }),
            );
            if (insert) administratorInserts.push(row);
          }
          const paymentInserts: Array<ReceiptPaymentAuthorityRow> = [];
          for (const row of plan.paymentAuthorities) {
            const insert = yield* insertionRequired(
              yield* overlappingPaymentAuthorities(sql, row),
              canonicalJson({
                kind: "ReceiptPaymentAuthority",
                personId: row.personId,
                departmentId: row.departmentId,
              }),
            );
            if (insert) paymentInserts.push(row);
          }
          const approvalInserts: Array<ReceiptApprovalGrantRow> = [];
          for (const row of plan.approvalGrants) {
            const insert = yield* insertionRequired(
              yield* overlappingApprovalGrants(sql, row),
              canonicalJson({
                kind: "ReceiptApprovalGrant",
                personId: row.personId,
                scope: row.scope,
                departmentId: row.departmentId,
              }),
            );
            if (insert) approvalInserts.push(row);
          }

          for (const row of administratorInserts) {
            yield* sql`
              INSERT INTO organization_global_administrator_grants (
                grant_id, person_id, start_at, end_at, revision
              ) VALUES (
                ${row.grantId}, ${row.personId}, ${row.startAt}::timestamptz,
                ${row.endAt}::timestamptz, 0
              )
              ON CONFLICT (grant_id) DO NOTHING
            `;
          }
          for (const row of paymentInserts) {
            yield* sql`
              INSERT INTO economy_payment_authorities (
                payment_authority_id, person_id, department_id, payment_account_ciphertext,
                start_at, end_at, revision
              ) VALUES (
                ${row.authorityId}, ${row.personId}, ${row.departmentId},
                ${row.paymentAccountCiphertext}, ${row.startAt}::timestamptz,
                ${row.endAt}::timestamptz, 0
              )
              ON CONFLICT (payment_authority_id) DO NOTHING
            `;
          }
          for (const row of approvalInserts) {
            yield* sql`
              INSERT INTO economy_receipt_approval_grants (
                approval_grant_id, person_id, scope, department_id, start_at, end_at, revision
              ) VALUES (
                ${row.grantId}, ${row.personId}, ${row.scope}, ${row.departmentId},
                ${row.startAt}::timestamptz, ${row.endAt}::timestamptz, 0
              )
              ON CONFLICT (approval_grant_id) DO NOTHING
            `;
          }

          return {
            personIds: plan.groups.map((group) => group.personId),
            verifiedMembershipIds: [...verifiedMembershipIds].sort(compareText),
            globalAdministratorGrantIds: plan.administratorGrants.map((row) => row.grantId),
            receiptPaymentAuthorityIds: plan.paymentAuthorities.map((row) => row.authorityId),
            receiptApprovalGrantIds: plan.approvalGrants.map((row) => row.grantId),
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () =>
          Effect.fail(
            new DisposableAuthorityEvidencePersistenceError({
              operation: "backfill disposable person authorities",
              message: "database rejected disposable authority evidence",
            }),
          ),
        ),
      );
  });
