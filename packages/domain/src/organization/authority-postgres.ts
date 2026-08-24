import { Effect, Schema } from "effect";
import { Database } from "../database/service.js";
import {
  OrganizationAuthorityInstantSchema,
  OrganizationGlobalAdministratorStatusSchema,
  type OrganizationAuthorityInstant,
  type OrganizationAuthorityMembership,
  type OrganizationPersonAuthority,
} from "./authority.js";
import { OrganizationDecodeError, OrganizationPersistenceError } from "./errors.js";
import { DepartmentId, MembershipId, PersonId, TeamId } from "./schema.js";

const OrganizationAuthorityProjectionRowSchema = Schema.Struct({
  globalAdministrator: OrganizationGlobalAdministratorStatusSchema,
  membershipId: Schema.NullOr(MembershipId),
  teamId: Schema.NullOr(TeamId),
  departmentId: Schema.NullOr(DepartmentId),
  active: Schema.NullOr(Schema.Boolean),
  teamLeader: Schema.NullOr(Schema.Boolean),
});
type OrganizationAuthorityProjectionRow = typeof OrganizationAuthorityProjectionRowSchema.Type;

const decodeError = (operation: string, cause: unknown) =>
  new OrganizationDecodeError({ operation, message: String(cause) });

const membershipFromRow = (
  row: OrganizationAuthorityProjectionRow,
): Effect.Effect<OrganizationAuthorityMembership | undefined, OrganizationDecodeError> => {
  if (row.membershipId === null) {
    return row.teamId === null &&
      row.departmentId === null &&
      row.active === null &&
      row.teamLeader === null
      ? Effect.succeed(undefined)
      : Effect.fail(
          decodeError(
            "decode Organization person authority",
            "membership projection has values without a membership identifier",
          ),
        );
  }
  if (
    row.teamId === null ||
    row.departmentId === null ||
    row.active === null ||
    row.teamLeader === null
  ) {
    return Effect.fail(
      decodeError(
        "decode Organization person authority",
        "membership projection is missing a required value",
      ),
    );
  }
  return Effect.succeed({
    membershipId: row.membershipId,
    teamId: row.teamId,
    departmentId: row.departmentId,
    active: row.active,
    teamLeader: row.teamLeader,
  });
};

export const resolveOrganizationPersonAuthority = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
): Effect.Effect<
  OrganizationPersonAuthority,
  OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const evaluatedAt = yield* Schema.decodeUnknownEffect(OrganizationAuthorityInstantSchema)(
      authorizationInstant,
    ).pipe(Effect.mapError((cause) => decodeError("decode Organization authority instant", cause)));
    const sql = yield* Database;
    const selected = yield* sql<OrganizationAuthorityProjectionRow>`
      WITH locked_global_administrator_grants AS MATERIALIZED (
        SELECT grant_id, start_at, end_at
        FROM organization_global_administrator_grants
        WHERE person_id = ${personId}
        FOR SHARE
      ),
      global_administrator AS (
        SELECT CASE
          WHEN COALESCE(
            bool_or(
              start_at <= ${evaluatedAt}::timestamptz
              AND (end_at IS NULL OR ${evaluatedAt}::timestamptz < end_at)
            ),
            FALSE
          ) THEN 'Active'
          WHEN count(*) > 0 THEN 'Inactive'
          ELSE 'Absent'
        END AS "globalAdministrator"
        FROM locked_global_administrator_grants
      ),
      person_memberships AS MATERIALIZED (
        SELECT
          membership.membership_id AS "membershipId",
          team.team_id AS "teamId",
          department.department_id AS "departmentId",
          (
            membership.start_at <= ${evaluatedAt}::timestamptz
            AND (
              membership.end_at IS NULL
              OR ${evaluatedAt}::timestamptz < membership.end_at
            )
            AND NOT membership.is_suspended
            AND team.active
            AND department.active
          ) AS active,
          membership.is_team_leader AS "teamLeader"
        FROM organization_memberships AS membership
        INNER JOIN organization_teams AS team
          ON team.team_id = membership.team_id
        INNER JOIN organization_departments AS department
          ON department.department_id = team.department_id
        WHERE membership.person_id = ${personId}
        FOR SHARE OF membership, team, department
      )
      SELECT
        global_administrator."globalAdministrator",
        membership."membershipId",
        membership."teamId",
        membership."departmentId",
        membership.active,
        membership."teamLeader"
      FROM global_administrator
      LEFT JOIN person_memberships AS membership ON TRUE
      ORDER BY
        membership."departmentId" ASC NULLS LAST,
        membership."teamId" ASC NULLS LAST,
        membership."membershipId" ASC NULLS LAST
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(
          new OrganizationPersistenceError({
            operation: "resolve Organization person authority",
            message: String(cause),
          }),
        ),
      ),
    );
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(OrganizationAuthorityProjectionRowSchema),
    )(selected, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => decodeError("decode Organization person authority", cause)),
    );
    const first = rows[0];
    if (first === undefined) {
      return yield* decodeError(
        "decode Organization person authority",
        "authority projection query returned no global-administrator status",
      );
    }
    const memberships: Array<OrganizationAuthorityMembership> = [];
    for (const row of rows) {
      if (row.globalAdministrator !== first.globalAdministrator) {
        return yield* decodeError(
          "decode Organization person authority",
          "authority projection returned inconsistent global-administrator statuses",
        );
      }
      const membership = yield* membershipFromRow(row);
      if (membership !== undefined) memberships.push(membership);
    }
    return {
      personId,
      evaluatedAt,
      globalAdministrator: first.globalAdministrator,
      memberships,
    };
  });
