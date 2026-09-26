import { Effect, Schema } from "effect";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { Database, type DatabaseOperations } from "../service.js";
import { Delegation } from "@vektorprogrammet/domain/authz";
import {
  CreateOrganizationGlobalAdministratorGrantInputSchema,
  EndOrganizationGlobalAdministratorGrantInputSchema,
  OrganizationAuthorityBoardSeatSchema,
  OrganizationAuthorityInstantSchema,
  OrganizationAuthorityMembershipSchema,
  OrganizationGlobalAdministratorGrantSchema,
  OrganizationGlobalAdministratorStatusSchema,
  RemoveOrganizationGlobalAdministratorGrantInputSchema,
  type OrganizationAuthorityInstant,
  type OrganizationGlobalAdministratorGrant,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import {
  OrganizationAuthorityRecordNotFound,
  OrganizationAuthorityWriteConflict,
  OrganizationDecodeError,
  OrganizationPersistenceError,
} from "@vektorprogrammet/domain/organization";
import { PersonId } from "@vektorprogrammet/domain/organization";

const decodeError = (operation: string, cause: unknown) =>
  new OrganizationDecodeError({ operation, message: String(cause) });

export type OrganizationAuthorityRowLockMode = "None" | "ForShare";

/**
 * Acquire before any person lock when changing the usable administrator set.
 *
 * @construct sql-lock
 */
export const lockOrganizationAdministratorSet = (sql: DatabaseOperations) =>
  lockAdvisory(sql, AdvisoryLockKey.administratorSet);

/**
 * Serializes one person's protected command with person-keyed authority writers.
 *
 * @construct sql-lock
 */
export const lockPersonAuthorization = (
  sql: DatabaseOperations,
  personId: PersonId,
): Effect.Effect<void, OrganizationPersistenceError> =>
  lockAdvisory(sql, AdvisoryLockKey.personAuthorization(personId)).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(
        new OrganizationPersistenceError({
          operation: "lock person authorization",
          message: String(cause),
          cause,
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
  sql: DatabaseOperations,
  grantId: OrganizationGlobalAdministratorGrant["grantId"],
  expectedRevision: number,
): Effect.Effect<OrganizationGlobalAdministratorGrant, OrganizationAuthorityWriteFailure> =>
  Effect.gen(function* () {
    yield* lockOrganizationAdministratorSet(sql);

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
  input: typeof CreateOrganizationGlobalAdministratorGrantInputSchema.Encoded,
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
          yield* lockOrganizationAdministratorSet(sql);
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
  input: typeof EndOrganizationGlobalAdministratorGrantInputSchema.Encoded,
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
  input: typeof RemoveOrganizationGlobalAdministratorGrantInputSchema.Encoded,
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

const GlobalAdministratorRowSchema = Schema.Struct({
  globalAdministrator: OrganizationGlobalAdministratorStatusSchema,
});

const OrganizationAuthorityFactsSchema = Schema.Struct({
  globalAdministrator: Schema.Array(GlobalAdministratorRowSchema),
  memberships: Schema.Array(OrganizationAuthorityMembershipSchema),
  nationalBoardSeats: Schema.Array(OrganizationAuthorityBoardSeatSchema),
  delegations: Schema.Array(Delegation),
});

/**
 * Caller-transaction Organization projection: the global-administrator grants, the team and
 * board appointments with their unit facts, the national board seats, and the delegations of the
 * person's teams. `ForShare` locks every row that the decision reads and is command-safe only
 * when the supplied SQL client is the state-transition transaction client.
 */
export const resolveOrganizationPersonAuthorityWithSql = (
  sql: DatabaseOperations,
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

    const shared = lockMode === "ForShare";

    const globalAdministrator = yield* sql`
      WITH locked_global_administrator_grants AS MATERIALIZED (
        SELECT grant_id, start_at, end_at
        FROM public.organization_global_administrator_grants AS administrator_grant
        WHERE person_id = ${personId}
        ORDER BY grant_id ASC
        ${shared ? sql`FOR SHARE` : sql``}
      )
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
    `;

    const memberships = yield* sql`
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
        ) AS active,
        membership.is_team_leader AS "unitLeader",
        team.kind AS "unitKind",
        team.team_scope AS "teamScope",
        department.independent AS "departmentIndependent"
      FROM public.organization_memberships AS membership
      INNER JOIN public.organization_teams AS team ON team.team_id = membership.team_id
      INNER JOIN public.organization_departments AS department
        ON department.department_id = team.department_id
      WHERE membership.person_id = ${personId}
      ORDER BY department.department_id ASC, team.team_id ASC, membership.membership_id ASC
      ${shared ? sql`FOR SHARE OF membership, team, department` : sql``}
    `;

    const nationalBoardSeats = yield* sql`
      SELECT
        membership.membership_id AS "membershipId",
        membership.board_id AS "boardId",
        (
          membership.start_at <= ${evaluatedAt}::timestamptz
          AND (membership.end_at IS NULL OR ${evaluatedAt}::timestamptz < membership.end_at)
          AND NOT membership.is_suspended
        ) AS active,
        membership.is_team_leader AS "unitLeader"
      FROM public.organization_memberships AS membership
      WHERE membership.person_id = ${personId} AND membership.board_id IS NOT NULL
      ORDER BY membership.board_id ASC, membership.membership_id ASC
      ${shared ? sql`FOR SHARE OF membership` : sql``}
    `;

    const delegations = yield* sql`
      SELECT
        delegation.delegation_id AS "delegationId",
        delegation.name,
        delegation.team_id AS "teamId",
        delegation.capability,
        CASE delegation.area
          WHEN 'Department' THEN jsonb_build_object(
            '_tag', 'Department', 'departmentId', delegation.area_department_id)
          ELSE jsonb_build_object('_tag', 'Organization')
        END AS area,
        delegation.holders,
        to_char(delegation.start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE
          WHEN delegation.end_at IS NULL THEN NULL
          ELSE to_char(delegation.end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        delegation.revision
      FROM public.organization_delegations AS delegation
      WHERE delegation.team_id IN (
        SELECT membership.team_id
        FROM public.organization_memberships AS membership
        WHERE membership.person_id = ${personId} AND membership.team_id IS NOT NULL
      )
      ORDER BY delegation.team_id ASC, delegation.delegation_id ASC
      ${shared ? sql`FOR SHARE OF delegation` : sql``}
    `;

    const facts = yield* Schema.decodeUnknownEffect(OrganizationAuthorityFactsSchema)(
      { globalAdministrator, memberships, nationalBoardSeats, delegations },
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError((cause) => decodeError("decode Organization person authority", cause)));

    const status = facts.globalAdministrator[0];

    if (status === undefined || facts.globalAdministrator.length !== 1) {
      return yield* decodeError(
        "decode Organization person authority",
        "authority projection returned no single global-administrator status",
      );
    }

    return {
      personId,
      evaluatedAt,
      globalAdministrator: status.globalAdministrator,
      memberships: facts.memberships,
      nationalBoardSeats: facts.nationalBoardSeats,
      delegations: facts.delegations,
    };
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(
        new OrganizationPersistenceError({
          operation: "resolve Organization person authority",
          message: String(cause),
          cause,
        }),
      ),
    ),
  );

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
