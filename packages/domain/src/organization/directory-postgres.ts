import { Effect, Schema } from "effect";
import { Database } from "../database/service.js";
import type { OrganizationAuthorityInstant } from "./authority.js";
import {
  OrganizationAuthorityInstantSchema,
  OrganizationGlobalAdministratorStatusSchema,
} from "./authority.js";
import {
  accumulateOrganizationDirectoryFacts,
  type OrganizationDirectoryFacts,
} from "./directory.js";
import { OrganizationDecodeError, OrganizationPersistenceError } from "./errors.js";
import { DepartmentId, PersonId } from "./schema.js";

const DirectoryMembershipRowSchema = Schema.Struct({
  personId: PersonId,
  departmentId: DepartmentId,
  active: Schema.Boolean,
});
type DirectoryMembershipRow = typeof DirectoryMembershipRowSchema.Type;

const DirectoryGrantRowSchema = Schema.Struct({
  personId: PersonId,
  globalAdministrator: OrganizationGlobalAdministratorStatusSchema,
});
type DirectoryGrantRow = typeof DirectoryGrantRowSchema.Type;

/**
 * Derives the spec 0057 directory facts for many persons in one snapshot.
 *
 * The SQL reuses the spec 0055 person-projection law verbatim: a membership
 * is active at instant t when startAt <= t, endAt is absent or t < endAt, the
 * membership is not suspended, and the referenced team and department are
 * active. Detached memberships (team_id NULL after team deletion) drop out of
 * the inner join and contribute nothing. Deleted-team history therefore yields
 * an Inactive row rather than an exclusion: the person stays in the result
 * with isActive false.
 */
export const deriveOrganizationDirectoryFacts = (
  personIds: ReadonlyArray<PersonId>,
  authorizationInstant: OrganizationAuthorityInstant,
): Effect.Effect<
  OrganizationDirectoryFacts,
  OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    if (personIds.length === 0) return new Map();
    const evaluatedAt = yield* Schema.decodeUnknownEffect(OrganizationAuthorityInstantSchema)(
      authorizationInstant,
    ).pipe(Effect.mapError((cause) => decodeError("decode Organization directory instant", cause)));
    const sql = yield* Database;
    const membershipRows = yield* sql<DirectoryMembershipRow>`
      SELECT DISTINCT
        membership.person_id AS "personId",
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
        ) AS active
      FROM organization_memberships AS membership
      INNER JOIN organization_teams AS team
        ON team.team_id = membership.team_id
      INNER JOIN organization_departments AS department
        ON department.department_id = team.department_id
      WHERE ${sql.in("membership.person_id", personIds)}
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(
          new OrganizationPersistenceError({
            operation: "derive Organization directory memberships",
            message: String(cause),
          }),
        ),
      ),
    );
    const decodedMemberships = yield* Schema.decodeUnknownEffect(
      Schema.Array(DirectoryMembershipRowSchema),
    )(membershipRows, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) => decodeError("decode Organization directory memberships", cause)),
    );
    const grantRows = yield* sql<DirectoryGrantRow>`
      SELECT
        g.person_id AS "personId",
        CASE
          WHEN COALESCE(
            bool_or(
              g.start_at <= ${evaluatedAt}::timestamptz
              AND (g.end_at IS NULL OR ${evaluatedAt}::timestamptz < g.end_at)
            ),
            FALSE
          ) THEN 'Active'
          WHEN count(*) > 0 THEN 'Inactive'
          ELSE 'Absent'
        END AS "globalAdministrator"
      FROM organization_global_administrator_grants AS g
      WHERE ${sql.in("g.person_id", personIds)}
      GROUP BY g.person_id
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(
          new OrganizationPersistenceError({
            operation: "derive Organization directory grants",
            message: String(cause),
          }),
        ),
      ),
    );
    const decodedGrants = yield* Schema.decodeUnknownEffect(Schema.Array(DirectoryGrantRowSchema))(
      grantRows,
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode Organization directory grants", cause)));
    return accumulateOrganizationDirectoryFacts({
      personIds,
      instant: evaluatedAt,
      memberships: decodedMemberships,
      grants: decodedGrants,
    });
  });

const decodeError = (operation: string, cause: unknown) =>
  new OrganizationDecodeError({ operation, message: String(cause) });
