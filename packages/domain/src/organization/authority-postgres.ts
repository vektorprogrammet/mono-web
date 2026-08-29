import { Effect, Schema } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import {
  CreateOrganizationGlobalAdministratorGrantInputSchema,
  EndOrganizationGlobalAdministratorGrantInputSchema,
  OrganizationAuthorityInstantSchema,
  OrganizationGlobalAdministratorGrantSchema,
  OrganizationGlobalAdministratorStatusSchema,
  RemoveOrganizationGlobalAdministratorGrantInputSchema,
  type OrganizationAuthorityInstant,
  type OrganizationAuthorityMembership,
  type OrganizationGlobalAdministratorGrant,
  type OrganizationPersonAuthority,
} from "./authority.js";
import {
  OrganizationAuthorityRecordNotFound,
  OrganizationAuthorityWriteConflict,
  OrganizationDecodeError,
  OrganizationPersistenceError,
} from "./errors.js";
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

export type OrganizationAuthorityRowLockMode = "None" | "ForShare";

const PERSON_AUTHORIZATION_LOCK_NAMESPACE = "vektorprogrammet:person-authorization:v1";

/** Serializes one person's protected command with person-keyed authority writers. */
export const lockPersonAuthorization = (
  sql: DatabaseShape,
  personId: PersonId,
): Effect.Effect<void, OrganizationPersistenceError> =>
  sql`
    SELECT pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${`${PERSON_AUTHORIZATION_LOCK_NAMESPACE}:${personId}`}, 0)
    )
  `.pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(
        new OrganizationPersistenceError({
          operation: "lock person authorization",
          message: String(cause),
        }),
      ),
    ),
  );

const OrganizationAuthorityPersonRowSchema = Schema.Struct({ personId: PersonId });
type OrganizationAuthorityPersonRow = typeof OrganizationAuthorityPersonRowSchema.Type;

export type OrganizationAuthorityWriteFailure =
  | OrganizationDecodeError
  | OrganizationPersistenceError
  | OrganizationAuthorityRecordNotFound
  | OrganizationAuthorityWriteConflict;

/**
 * Locks one existing grant in the global person-before-authority-row order.
 * The unlocked person lookup is repeated under the advisory and row locks so
 * a delete/reinsert cannot move the authority to another person.
 */
export const lockOrganizationGlobalAdministratorGrantForWrite = (
  sql: DatabaseShape,
  grantId: OrganizationGlobalAdministratorGrant["grantId"],
  expectedRevision: number,
): Effect.Effect<OrganizationGlobalAdministratorGrant, OrganizationAuthorityWriteFailure> =>
  Effect.gen(function* () {
    const observedRows = yield* sql<OrganizationAuthorityPersonRow>`
      SELECT person_id AS "personId"
      FROM public.organization_global_administrator_grants
      WHERE grant_id = ${grantId}
    `;
    const observed = yield* Schema.decodeUnknownEffect(
      Schema.Array(OrganizationAuthorityPersonRowSchema),
    )(observedRows, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) =>
        decodeError("decode Organization global-administrator grant person", cause),
      ),
    );
    const observedPerson = observed[0]?.personId;
    if (observedPerson === undefined) {
      return yield* new OrganizationAuthorityRecordNotFound({ grantId });
    }

    yield* lockPersonAuthorization(sql, observedPerson);
    const lockedRows = yield* sql<OrganizationGlobalAdministratorGrant>`
      SELECT
        grant_id AS "grantId",
        person_id AS "personId",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE
          WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        revision
      FROM public.organization_global_administrator_grants
      WHERE grant_id = ${grantId}
      FOR UPDATE
    `;
    const locked = yield* Schema.decodeUnknownEffect(
      Schema.Array(OrganizationGlobalAdministratorGrantSchema),
    )(lockedRows, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) =>
        decodeError("decode locked Organization global-administrator grant", cause),
      ),
    );
    const grant = locked[0];
    if (
      grant === undefined ||
      grant.personId !== observedPerson ||
      grant.revision !== expectedRevision
    ) {
      return yield* new OrganizationAuthorityWriteConflict({ grantId, expectedRevision });
    }
    return grant;
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(
        new OrganizationPersistenceError({
          operation: "lock Organization global-administrator grant",
          message: String(cause),
        }),
      ),
    ),
  );

export const createOrganizationGlobalAdministratorGrant = (
  input: unknown,
): Effect.Effect<
  OrganizationGlobalAdministratorGrant,
  OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const grant = yield* Schema.decodeUnknownEffect(
      CreateOrganizationGlobalAdministratorGrantInputSchema,
    )(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) =>
        decodeError("decode Organization global-administrator grant creation", cause),
      ),
    );
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockPersonAuthorization(sql, grant.personId);
          yield* sql`
            INSERT INTO public.organization_global_administrator_grants (
              grant_id,
              person_id,
              start_at,
              end_at,
              revision
            ) VALUES (
              ${grant.grantId},
              ${grant.personId},
              ${grant.startAt},
              ${grant.endAt},
              0
            )
          `;
          return yield* Schema.decodeUnknownEffect(OrganizationGlobalAdministratorGrantSchema)(
            { ...grant, revision: 0 },
            { onExcessProperty: "error" },
          ).pipe(
            Effect.mapError((cause) =>
              decodeError("decode created Organization global-administrator grant", cause),
            ),
          );
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new OrganizationPersistenceError({
              operation: "create Organization global-administrator grant",
              message: String(cause),
            }),
          ),
        ),
      );
  });

export const endOrganizationGlobalAdministratorGrant = (
  input: unknown,
): Effect.Effect<
  OrganizationGlobalAdministratorGrant,
  OrganizationAuthorityWriteFailure,
  Database
> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(
      EndOrganizationGlobalAdministratorGrantInputSchema,
    )(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) =>
        decodeError("decode Organization global-administrator grant ending", cause),
      ),
    );
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* lockOrganizationGlobalAdministratorGrantForWrite(
            sql,
            command.grantId,
            command.expectedRevision,
          );
          const ended = yield* Schema.decodeUnknownEffect(
            OrganizationGlobalAdministratorGrantSchema,
          )(
            {
              ...current,
              endAt: command.endAt,
              revision: current.revision + 1,
            },
            { onExcessProperty: "error" },
          ).pipe(
            Effect.mapError((cause) =>
              decodeError("decode ended Organization global-administrator grant", cause),
            ),
          );
          const updated = yield* sql<{ readonly grantId: string }>`
            UPDATE public.organization_global_administrator_grants
            SET end_at = ${ended.endAt}, revision = revision + 1
            WHERE grant_id = ${command.grantId}
              AND revision = ${command.expectedRevision}
            RETURNING grant_id AS "grantId"
          `;
          if (updated.length !== 1) {
            return yield* new OrganizationAuthorityWriteConflict({
              grantId: command.grantId,
              expectedRevision: command.expectedRevision,
            });
          }
          return ended;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new OrganizationPersistenceError({
              operation: "end Organization global-administrator grant",
              message: String(cause),
            }),
          ),
        ),
      );
  });

export const removeOrganizationGlobalAdministratorGrant = (
  input: unknown,
): Effect.Effect<
  OrganizationGlobalAdministratorGrant,
  OrganizationAuthorityWriteFailure,
  Database
> =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(
      RemoveOrganizationGlobalAdministratorGrantInputSchema,
    )(input, { onExcessProperty: "error" }).pipe(
      Effect.mapError((cause) =>
        decodeError("decode Organization global-administrator grant removal", cause),
      ),
    );
    const sql = yield* Database;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* lockOrganizationGlobalAdministratorGrantForWrite(
            sql,
            command.grantId,
            command.expectedRevision,
          );
          const removed = yield* sql<{ readonly grantId: string }>`
            DELETE FROM public.organization_global_administrator_grants
            WHERE grant_id = ${command.grantId}
              AND revision = ${command.expectedRevision}
            RETURNING grant_id AS "grantId"
          `;
          if (removed.length !== 1) {
            return yield* new OrganizationAuthorityWriteConflict({
              grantId: command.grantId,
              expectedRevision: command.expectedRevision,
            });
          }
          return current;
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new OrganizationPersistenceError({
              operation: "remove Organization global-administrator grant",
              message: String(cause),
            }),
          ),
        ),
      );
  });

/**
 * Caller-transaction Organization projection. `ForShare` is command-safe only
 * when the supplied SQL client is the state-transition transaction client.
 */
export const resolveOrganizationPersonAuthorityWithSql = (
  sql: DatabaseShape,
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
  lockMode: OrganizationAuthorityRowLockMode,
): Effect.Effect<
  OrganizationPersonAuthority,
  OrganizationDecodeError | OrganizationPersistenceError
> =>
  Effect.gen(function* () {
    const evaluatedAt = yield* Schema.decodeUnknownEffect(OrganizationAuthorityInstantSchema)(
      authorizationInstant,
    ).pipe(Effect.mapError((cause) => decodeError("decode Organization authority instant", cause)));
    const globalAdministratorLock = lockMode === "ForShare" ? sql`FOR SHARE` : sql``;
    const membershipLock =
      lockMode === "ForShare" ? sql`FOR SHARE OF membership, team, department` : sql``;
    const selected = yield* sql<OrganizationAuthorityProjectionRow>`
      WITH locked_global_administrator_grants AS MATERIALIZED (
        SELECT grant_id, start_at, end_at
        FROM public.organization_global_administrator_grants
        WHERE person_id = ${personId}
        ORDER BY grant_id ASC
        ${globalAdministratorLock}
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
        ORDER BY department.department_id ASC, team.team_id ASC, membership.membership_id ASC
        ${membershipLock}
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

/** Existing service projection; receipt commands use the caller-SQL form. */
export const resolveOrganizationPersonAuthority = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    return yield* resolveOrganizationPersonAuthorityWithSql(
      sql,
      personId,
      authorizationInstant,
      "ForShare",
    );
  });

/** Read projection for a caller-owned repeatable-read, read-only snapshot. */
export const resolveOrganizationPersonAuthorityForRead = (
  personId: PersonId,
  authorizationInstant: OrganizationAuthorityInstant,
) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    return yield* resolveOrganizationPersonAuthorityWithSql(
      sql,
      personId,
      authorizationInstant,
      "None",
    );
  });
