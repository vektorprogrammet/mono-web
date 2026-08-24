import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Database } from "@vektorprogrammet/domain/database";
import { Effect, ManagedRuntime } from "effect";
import { DatabaseTest } from "../layers.js";
import {
  backfillDisposablePersonAuthoritiesFromPreConfigEvidence,
  type DisposablePersonAuthorityBackfillResult,
} from "./disposable-person-authority-backfill.js";

const EVALUATED_AT = "2031-09-15T12:00:00.000Z";
const AUTHORITY_START_AT = "2030-01-01T00:00:00.000Z";

const runtime = ManagedRuntime.make(DatabaseTest());

interface AuthoritySnapshotRow {
  readonly id: string;
  readonly personId: string;
  readonly departmentId: string | null;
  readonly scope: string | null;
  readonly paymentAccountCiphertext: string | null;
}

interface MembershipSnapshotRow {
  readonly membershipId: string;
  readonly personId: string;
  readonly teamId: string | null;
  readonly teamLeader: boolean;
}

interface CountRow {
  readonly count: string;
}

const preConfigEvidence = (
  admission: ReadonlyArray<readonly [string, unknown]>,
  organization: ReadonlyArray<readonly [string, unknown]>,
  receipt: ReadonlyArray<readonly [string, unknown]>,
): unknown => ({
  evaluatedAt: EVALUATED_AT,
  authorityStartAt: AUTHORITY_START_AT,
  admission: Object.fromEntries(admission),
  organization: Object.fromEntries(organization),
  receipt: Object.fromEntries(receipt),
});

const resetDisposableFixture = Effect.gen(function* () {
  const sql = yield* Database;
  yield* sql`DELETE FROM economy_receipt_approval_grants`;
  yield* sql`DELETE FROM economy_payment_authorities`;
  yield* sql`DELETE FROM organization_global_administrator_grants`;
  yield* sql`DELETE FROM organization_memberships`;
  yield* sql`DELETE FROM organization_teams`;
  yield* sql`DELETE FROM organization_departments`;
  yield* sql`DELETE FROM person_profiles`;
});

const seedCanonicalOrganizationFixture = Effect.gen(function* () {
  const sql = yield* Database;
  yield* sql`
    INSERT INTO person_profiles (person_id, first_name, last_name)
    VALUES
      ('authority-admin', 'Ada', 'Admin'),
      ('authority-leader', 'Lise', 'Leader'),
      ('authority-member', 'Mona', 'Member'),
      ('authority-global-approver', 'Greta', 'Approver'),
      ('authority-missing-membership', 'Mika', 'Missing')
  `;
  yield* sql`
    INSERT INTO organization_departments (
      department_id, name, short_name, email, city
    ) VALUES
      (
        'authority-department-a', 'Authority Department A', 'ADA',
        'authority-a@example.invalid', 'Bergen'
      ),
      (
        'authority-department-b', 'Authority Department B', 'ADB',
        'authority-b@example.invalid', 'Trondheim'
      )
  `;
  yield* sql`
    INSERT INTO organization_teams (team_id, department_id, name)
    VALUES
      ('authority-team-a', 'authority-department-a', 'Authority Team A'),
      ('authority-team-b', 'authority-department-b', 'Authority Team B')
  `;
  yield* sql`
    INSERT INTO organization_memberships (
      membership_id, person_id, team_id, start_at, position_id, is_team_leader
    ) VALUES
      (
        'authority-membership-leader', 'authority-leader', 'authority-team-a',
        '2030-01-01T00:00:00.000Z', 'leader', TRUE
      ),
      (
        'authority-membership-member', 'authority-member', 'authority-team-a',
        '2030-01-01T00:00:00.000Z', 'member', FALSE
      ),
      (
        'authority-membership-global-approver', 'authority-global-approver',
        'authority-team-b', '2030-01-01T00:00:00.000Z', 'approver', FALSE
      )
  `;
});

const readAuthoritySnapshot = Effect.gen(function* () {
  const sql = yield* Database;
  const administrators = yield* sql<AuthoritySnapshotRow>`
    SELECT
      grant_id AS "id",
      person_id AS "personId",
      NULL::text AS "departmentId",
      NULL::text AS "scope",
      NULL::text AS "paymentAccountCiphertext"
    FROM organization_global_administrator_grants
    ORDER BY grant_id
  `;
  const payments = yield* sql<AuthoritySnapshotRow>`
    SELECT
      payment_authority_id AS "id",
      person_id AS "personId",
      department_id AS "departmentId",
      NULL::text AS "scope",
      payment_account_ciphertext AS "paymentAccountCiphertext"
    FROM economy_payment_authorities
    ORDER BY payment_authority_id
  `;
  const approvals = yield* sql<AuthoritySnapshotRow>`
    SELECT
      approval_grant_id AS "id",
      person_id AS "personId",
      department_id AS "departmentId",
      scope,
      NULL::text AS "paymentAccountCiphertext"
    FROM economy_receipt_approval_grants
    ORDER BY approval_grant_id
  `;
  return { administrators, payments, approvals };
});

const readMembershipSnapshot = Effect.gen(function* () {
  const sql = yield* Database;
  return yield* sql<MembershipSnapshotRow>`
    SELECT
      membership_id AS "membershipId",
      person_id AS "personId",
      team_id AS "teamId",
      is_team_leader AS "teamLeader"
    FROM organization_memberships
    ORDER BY membership_id
  `;
});

const countInsertedAuthorities = Effect.gen(function* () {
  const sql = yield* Database;
  const [administrators, payments, approvals] = yield* Effect.all([
    sql<CountRow>`
      SELECT count(*)::text AS "count"
      FROM organization_global_administrator_grants
    `,
    sql<CountRow>`
      SELECT count(*)::text AS "count"
      FROM economy_payment_authorities
    `,
    sql<CountRow>`
      SELECT count(*)::text AS "count"
      FROM economy_receipt_approval_grants
    `,
  ]);
  return {
    administrators: Number(administrators[0]?.count ?? "0"),
    payments: Number(payments[0]?.count ?? "0"),
    approvals: Number(approvals[0]?.count ?? "0"),
  };
});

beforeEach(async () => {
  await runtime.runPromise(resetDisposableFixture);
  await runtime.runPromise(seedCanonicalOrganizationFixture);
});

afterAll(async () => {
  await runtime.dispose();
});

describe("disposable person-authority token evidence backfill", () => {
  it("writes stable administrator and Economy authority rows without retaining token keys", async () => {
    const admissionEntries = [
      [
        "admission-token-leader-0055",
        {
          _tag: "DepartmentLeader",
          personId: "authority-leader",
          departmentId: "authority-department-a",
          active: true,
        },
      ],
      [
        "admission-token-global-approver-0055",
        {
          actor: {
            _tag: "Member",
            personId: "authority-global-approver",
            departmentId: "authority-department-b",
            active: true,
          },
        },
      ],
    ] as const;
    const organizationEntries = [
      [
        "organization-token-admin-0055",
        { _tag: "OrganizationAdministrator", personId: "authority-admin" },
      ],
      [
        "organization-token-leader-0055",
        { _tag: "OrganizationMember", personId: "authority-leader" },
      ],
      [
        "organization-token-global-approver-0055",
        { _tag: "OrganizationMember", personId: "authority-global-approver" },
      ],
    ] as const;
    const receiptEntries = [
      [
        "receipt-token-leader-0055",
        {
          personId: "authority-leader",
          departmentId: "authority-department-a",
          active: true,
          approvalScope: {
            _tag: "Department",
            departmentId: "authority-department-a",
          },
          paymentAccountCiphertext: "ciphertext-authority-leader",
        },
      ],
      [
        "receipt-token-global-approver-0055",
        {
          personId: "authority-global-approver",
          departmentId: "authority-department-b",
          active: true,
          approvalScope: { _tag: "Global" },
          paymentAccountCiphertext: "ciphertext-authority-global-approver",
        },
      ],
    ] as const;

    const first = await runtime.runPromise(
      backfillDisposablePersonAuthoritiesFromPreConfigEvidence(
        preConfigEvidence(admissionEntries, organizationEntries, receiptEntries),
      ),
    );
    const firstSnapshot = await runtime.runPromise(readAuthoritySnapshot);

    expect(first.globalAdministratorGrantIds).toHaveLength(1);
    expect(first.receiptPaymentAuthorityIds).toHaveLength(2);
    expect(first.receiptApprovalGrantIds).toHaveLength(2);
    expect(firstSnapshot.administrators).toHaveLength(1);
    expect(firstSnapshot.payments).toHaveLength(2);
    expect(firstSnapshot.approvals).toHaveLength(2);
    const storedAuthorityJson = JSON.stringify(firstSnapshot);
    for (const [token] of [...admissionEntries, ...organizationEntries, ...receiptEntries]) {
      expect(storedAuthorityJson).not.toContain(token);
      expect(JSON.stringify(first)).not.toContain(token);
    }

    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* Database;
        yield* sql`DELETE FROM economy_receipt_approval_grants`;
        yield* sql`DELETE FROM economy_payment_authorities`;
        yield* sql`DELETE FROM organization_global_administrator_grants`;
      }),
    );
    const second = await runtime.runPromise(
      backfillDisposablePersonAuthoritiesFromPreConfigEvidence(
        preConfigEvidence(
          [...admissionEntries].reverse(),
          [...organizationEntries].reverse(),
          [...receiptEntries].reverse(),
        ),
      ),
    );
    const secondSnapshot = await runtime.runPromise(readAuthoritySnapshot);

    expect(second).toEqual(first);
    expect(secondSnapshot).toEqual(firstSnapshot);
  });

  it("rejects conflicting facts for one person and department before writing", async () => {
    const failure = await runtime.runPromise(
      Effect.flip(
        backfillDisposablePersonAuthoritiesFromPreConfigEvidence(
          preConfigEvidence(
            [
              [
                "conflict-token-leader-0055",
                {
                  _tag: "DepartmentLeader",
                  personId: "authority-leader",
                  departmentId: "authority-department-a",
                  active: true,
                },
              ],
              [
                "conflict-token-member-0055",
                {
                  _tag: "Member",
                  personId: "authority-leader",
                  departmentId: "authority-department-a",
                  active: true,
                },
              ],
            ],
            [],
            [],
          ),
        ),
      ),
    );

    expect(failure._tag).toBe("DisposableAuthorityEvidenceConflict");
    expect(await runtime.runPromise(countInsertedAuthorities)).toEqual({
      administrators: 0,
      payments: 0,
      approvals: 0,
    });
  });

  it("verifies member and leader evidence without copying Organization role rows", async () => {
    const before = await runtime.runPromise(readMembershipSnapshot);
    const result = await runtime.runPromise(
      backfillDisposablePersonAuthoritiesFromPreConfigEvidence(
        preConfigEvidence(
          [
            [
              "member-proof-leader-token-0055",
              {
                _tag: "DepartmentLeader",
                personId: "authority-leader",
                departmentId: "authority-department-a",
                active: true,
              },
            ],
            [
              "member-proof-member-token-0055",
              {
                _tag: "Member",
                personId: "authority-member",
                departmentId: "authority-department-a",
                active: true,
              },
            ],
          ],
          [
            [
              "member-proof-organization-leader-token-0055",
              { _tag: "OrganizationMember", personId: "authority-leader" },
            ],
            [
              "member-proof-organization-member-token-0055",
              { _tag: "OrganizationMember", personId: "authority-member" },
            ],
          ],
          [],
        ),
      ),
    );
    const after = await runtime.runPromise(readMembershipSnapshot);

    const expectedResult = {
      personIds: ["authority-leader", "authority-member"],
      verifiedMembershipIds: ["authority-membership-leader", "authority-membership-member"],
      globalAdministratorGrantIds: [],
      receiptPaymentAuthorityIds: [],
      receiptApprovalGrantIds: [],
    } satisfies DisposablePersonAuthorityBackfillResult;
    expect(result).toEqual(expectedResult);
    expect(after).toEqual(before);
    expect(await runtime.runPromise(countInsertedAuthorities)).toEqual({
      administrators: 0,
      payments: 0,
      approvals: 0,
    });
  });

  it("rejects a member fact whose canonical membership reference is absent", async () => {
    const failure = await runtime.runPromise(
      Effect.flip(
        backfillDisposablePersonAuthoritiesFromPreConfigEvidence(
          preConfigEvidence(
            [
              [
                "missing-membership-token-0055",
                {
                  _tag: "Member",
                  personId: "authority-missing-membership",
                  departmentId: "authority-department-a",
                  active: true,
                },
              ],
            ],
            [],
            [],
          ),
        ),
      ),
    );

    expect(failure._tag).toBe("DisposableAuthorityEvidenceMissingReference");
    if (failure._tag === "DisposableAuthorityEvidenceMissingReference") {
      expect(failure.referenceKind).toBe("Membership");
      expect(failure.referenceId).toBe("authority-department-a");
    }
    expect(await runtime.runPromise(countInsertedAuthorities)).toEqual({
      administrators: 0,
      payments: 0,
      approvals: 0,
    });
  });

  it("rejects an equivalent preexisting grant with a non-stable duplicate identity", async () => {
    await runtime.runPromise(
      Database.use(
        (sql) => sql`
        INSERT INTO organization_global_administrator_grants (
          grant_id, person_id, start_at, end_at, revision
        ) VALUES (
          'ambiguous-existing-grant', 'authority-admin',
          ${AUTHORITY_START_AT}::timestamptz, NULL, 0
        )
      `,
      ),
    );

    const failure = await runtime.runPromise(
      Effect.flip(
        backfillDisposablePersonAuthoritiesFromPreConfigEvidence(
          preConfigEvidence(
            [],
            [
              [
                "ambiguous-admin-token-0055",
                { _tag: "OrganizationAdministrator", personId: "authority-admin" },
              ],
            ],
            [],
          ),
        ),
      ),
    );

    expect(failure._tag).toBe("DisposableAuthorityEvidenceAmbiguousDuplicate");
    expect(await runtime.runPromise(countInsertedAuthorities)).toEqual({
      administrators: 1,
      payments: 0,
      approvals: 0,
    });
  });

  it("strictly rejects excess fields and non-JSON map inputs", async () => {
    const excessFailure = await runtime.runPromise(
      Effect.flip(
        backfillDisposablePersonAuthoritiesFromPreConfigEvidence(
          preConfigEvidence(
            [
              [
                "excess-field-token-0055",
                {
                  _tag: "Member",
                  personId: "authority-member",
                  departmentId: "authority-department-a",
                  active: true,
                  bearerTokenCopy: "must-not-be-accepted",
                },
              ],
            ],
            [],
            [],
          ),
        ),
      ),
    );
    expect(excessFailure._tag).toBe("DisposableAuthorityEvidenceDecodeError");

    const nondeterministicFailure = await runtime.runPromise(
      Effect.flip(
        backfillDisposablePersonAuthoritiesFromPreConfigEvidence({
          evaluatedAt: EVALUATED_AT,
          authorityStartAt: AUTHORITY_START_AT,
          admission: new Map(),
          organization: {},
          receipt: {},
        }),
      ),
    );
    expect(nondeterministicFailure._tag).toBe("DisposableAuthorityEvidenceNondeterministicInput");
  });

  it("rejects a zero-width interval when inactive evidence must be ended", async () => {
    const failure = await runtime.runPromise(
      Effect.flip(
        backfillDisposablePersonAuthoritiesFromPreConfigEvidence({
          evaluatedAt: EVALUATED_AT,
          authorityStartAt: EVALUATED_AT,
          admission: {
            "inactive-interval-token-0055": {
              _tag: "Member",
              personId: "authority-member",
              departmentId: "authority-department-a",
              active: false,
            },
          },
          organization: {},
          receipt: {},
        }),
      ),
    );

    expect(failure._tag).toBe("DisposableAuthorityEvidenceDecodeError");
  });
});
