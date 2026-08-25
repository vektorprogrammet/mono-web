import { Database, type DatabaseShape } from "../database/service.js";
import * as Statement from "effect/unstable/sql/Statement";
import { Effect, Schema } from "effect";
import {
  DepartmentNotFound,
  MembershipInvalidInterval,
  MembershipNotFound,
  MembershipRevisionConflict,
  MembershipStaleRevision,
  OrganizationImportError,
  OrganizationDecodeError,
  OrganizationPersistenceError,
  TeamNotFound,
} from "./errors.js";
import {
  Department,
  type DepartmentSelect,
  Team,
  type TeamSelect,
  Membership,
  MembershipInvariantSchema,
  type MembershipSelect,
  TeamInterestRegistration,
  type TeamInterestRegistrationSelect,
  type MembershipId,
  type DepartmentId,
  type TeamId,
} from "./schema.js";
import type { TeamInterestFilter } from "./service.js";
import {
  importLegacyOrganizationEffect,
  type LegacyOrganizationSnapshot,
  type OrganizationImportLedgerEntry,
  type OrganizationImportResult,
  type OrganizationQuarantine,
} from "./import.js";
import { applyMembershipRevision, type MembershipRevisionCommand } from "./transitions.js";

const persistenceError = (operation: string, cause: unknown) =>
  new OrganizationPersistenceError({ operation, message: String(cause) });

const decodeDepartment = (row: unknown): Effect.Effect<Department, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(Department)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationDecodeError({
          operation: "decode Department select",
          message: String(cause),
        }),
    ),
  );

const decodeTeam = (row: unknown): Effect.Effect<Team, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(Team)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationDecodeError({ operation: "decode Team select", message: String(cause) }),
    ),
  );

const decodeMembership = (row: unknown): Effect.Effect<Membership, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(MembershipInvariantSchema)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationDecodeError({
          operation: "decode Membership select",
          message: String(cause),
        }),
    ),
  );

const findDepartment = (
  sql: DatabaseShape,
  departmentId: DepartmentId,
): Effect.Effect<Department | undefined, OrganizationDecodeError | OrganizationPersistenceError> =>
  sql<DepartmentSelect>`
    SELECT
      department_id AS "departmentId",
      name,
      short_name AS "shortName",
      email,
      address,
      city,
      latitude,
      longitude,
      slack_channel AS "slackChannel",
      logo_path AS "logoPath",
      active,
      revision
    FROM organization_departments
    WHERE department_id = ${departmentId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeDepartment(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read organization department", cause)),
    ),
  );

export const readOrganizationDepartment = (
  departmentId: DepartmentId,
): Effect.Effect<
  Department,
  DepartmentNotFound | OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const department = yield* findDepartment(sql, departmentId);
    return department === undefined ? yield* new DepartmentNotFound({ departmentId }) : department;
  });

export const listOrganizationDepartments = (): Effect.Effect<
  ReadonlyArray<Department>,
  OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<DepartmentSelect>`
      SELECT
        department_id AS "departmentId",
        name,
        short_name AS "shortName",
        email,
        address,
        city,
        latitude,
        longitude,
        slack_channel AS "slackChannel",
        logo_path AS "logoPath",
        active,
        revision
      FROM organization_departments
      ORDER BY department_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("list organization departments", cause)),
      ),
    );
    return yield* Effect.forEach(rows, decodeDepartment);
  });

const findTeam = (
  sql: DatabaseShape,
  teamId: TeamId,
): Effect.Effect<Team | undefined, OrganizationDecodeError | OrganizationPersistenceError> =>
  sql<TeamSelect>`
    SELECT
      team_id AS "teamId",
      department_id AS "departmentId",
      name,
      email,
      description,
      short_description AS "shortDescription",
      accept_application AS "acceptApplication",
      CASE WHEN deadline IS NULL THEN NULL
        ELSE to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      END AS deadline,
      active,
      revision
    FROM organization_teams
    WHERE team_id = ${teamId}
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeTeam(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read organization team", cause)),
    ),
  );

export const readOrganizationTeam = (
  teamId: TeamId,
): Effect.Effect<
  Team,
  TeamNotFound | OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const team = yield* findTeam(sql, teamId);
    return team === undefined ? yield* new TeamNotFound({ teamId }) : team;
  });

export const listOrganizationTeams = (
  departmentId?: DepartmentId,
): Effect.Effect<
  ReadonlyArray<Team>,
  OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows =
      departmentId === undefined
        ? yield* sql<TeamSelect>`
            SELECT
              team_id AS "teamId",
              department_id AS "departmentId",
              name,
              email,
              description,
              short_description AS "shortDescription",
              accept_application AS "acceptApplication",
              CASE WHEN deadline IS NULL THEN NULL
                ELSE to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              END AS deadline,
              active,
              revision
            FROM organization_teams
            ORDER BY department_id ASC, team_id ASC
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("list organization teams", cause)),
            ),
          )
        : yield* sql<TeamSelect>`
            SELECT
              team_id AS "teamId",
              department_id AS "departmentId",
              name,
              email,
              description,
              short_description AS "shortDescription",
              accept_application AS "acceptApplication",
              CASE WHEN deadline IS NULL THEN NULL
                ELSE to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              END AS deadline,
              active,
              revision
            FROM organization_teams
            WHERE department_id = ${departmentId}
            ORDER BY team_id ASC
          `.pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(persistenceError("list organization teams", cause)),
            ),
          );
    return yield* Effect.forEach(rows, decodeTeam);
  });

const findMembership = (
  sql: DatabaseShape,
  membershipId: MembershipId,
  forUpdate: boolean,
): Effect.Effect<
  Membership | undefined,
  OrganizationDecodeError | OrganizationPersistenceError
> => {
  const query = forUpdate
    ? sql<MembershipSelect>`
        SELECT
          membership_id AS "membershipId",
          person_id AS "personId",
          team_id AS "teamId",
          deleted_team_name AS "deletedTeamName",
          to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
          CASE WHEN end_at IS NULL THEN NULL
            ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS "endAt",
          position_id AS "positionId",
          is_team_leader AS "isTeamLeader",
          is_suspended AS "isSuspended",
          revision
        FROM organization_memberships
        WHERE membership_id = ${membershipId}
        FOR UPDATE
      `
    : sql<MembershipSelect>`
        SELECT
          membership_id AS "membershipId",
          person_id AS "personId",
          team_id AS "teamId",
          deleted_team_name AS "deletedTeamName",
          to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
          CASE WHEN end_at IS NULL THEN NULL
            ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS "endAt",
          position_id AS "positionId",
          is_team_leader AS "isTeamLeader",
          is_suspended AS "isSuspended",
          revision
        FROM organization_memberships
        WHERE membership_id = ${membershipId}
      `;
  return query.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.succeed(undefined) : decodeMembership(rows[0]),
    ),
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read organization membership", cause)),
    ),
  );
};
export const readOrganizationMembership = (
  membershipId: MembershipId,
): Effect.Effect<
  Membership,
  MembershipNotFound | OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const membership = yield* findMembership(sql, membershipId, false);
    return membership === undefined ? yield* new MembershipNotFound({ membershipId }) : membership;
  });

export const listOrganizationMembershipsForTeam = (
  teamId: TeamId,
): Effect.Effect<
  ReadonlyArray<Membership>,
  OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<MembershipSelect>`
      SELECT
        membership_id AS "membershipId",
        person_id AS "personId",
        team_id AS "teamId",
        deleted_team_name AS "deletedTeamName",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        position_id AS "positionId",
        is_team_leader AS "isTeamLeader",
        is_suspended AS "isSuspended",
        revision
      FROM organization_memberships
      WHERE team_id = ${teamId}
      ORDER BY start_at ASC, membership_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("list organization team memberships", cause)),
      ),
    );
    return yield* Effect.forEach(rows, decodeMembership);
  });

export const listOrganizationHistoricalMemberships = (): Effect.Effect<
  ReadonlyArray<Membership>,
  OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<MembershipSelect>`
      SELECT
        membership_id AS "membershipId",
        person_id AS "personId",
        team_id AS "teamId",
        deleted_team_name AS "deletedTeamName",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        position_id AS "positionId",
        is_team_leader AS "isTeamLeader",
        is_suspended AS "isSuspended",
        revision
      FROM organization_memberships
      WHERE team_id IS NULL
      ORDER BY start_at ASC, membership_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("list organization historical memberships", cause)),
      ),
    );
    return yield* Effect.forEach(rows, decodeMembership);
  });
const updateMembership = (
  sql: DatabaseShape,
  current: Membership,
  next: Membership,
): Effect.Effect<
  Membership,
  OrganizationDecodeError | OrganizationPersistenceError | MembershipRevisionConflict
> =>
  Effect.gen(function* () {
    const rows = yield* sql<MembershipSelect>`
      UPDATE organization_memberships
      SET
        end_at = ${next.endAt},
        position_id = ${next.positionId},
        is_team_leader = ${next.isTeamLeader},
        is_suspended = ${next.isSuspended},
        revision = revision + 1
      WHERE membership_id = ${current.membershipId}
        AND revision = ${current.revision}
      RETURNING
        membership_id AS "membershipId",
        person_id AS "personId",
        team_id AS "teamId",
        deleted_team_name AS "deletedTeamName",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        END AS "endAt",
        position_id AS "positionId",
        is_team_leader AS "isTeamLeader",
        is_suspended AS "isSuspended",
        revision
    `;
    if (rows[0] === undefined) {
      return yield* new MembershipRevisionConflict({ membershipId: current.membershipId });
    }
    return yield* decodeMembership(rows[0]);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("revise organization membership", cause)),
    ),
  );

type MembershipRevisionPersistenceError =
  | MembershipNotFound
  | OrganizationDecodeError
  | OrganizationPersistenceError
  | MembershipRevisionConflict
  | MembershipInvalidInterval
  | MembershipStaleRevision;

const executeMembershipRevision = (
  command: MembershipRevisionCommand,
): Effect.Effect<Membership, MembershipRevisionPersistenceError, Database> =>
  Effect.gen(function* () {
    const database = yield* Database;
    return yield* database
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* findMembership(database, command.membershipId, true);
          if (current === undefined)
            return yield* new MembershipNotFound({ membershipId: command.membershipId });
          const next = yield* applyMembershipRevision(current, command);
          return yield* updateMembership(database, current, next);
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("organization membership transaction", cause)),
        ),
      );
  });

export const reviseOrganizationMembership = (
  command: Extract<MembershipRevisionCommand, { readonly _tag: "ReviseMembership" }>,
): Effect.Effect<Membership, MembershipRevisionPersistenceError, Database> =>
  executeMembershipRevision(command);

export const suspendOrganizationMembership = (
  command: Extract<MembershipRevisionCommand, { readonly _tag: "SuspendMembership" }>,
): Effect.Effect<Membership, MembershipRevisionPersistenceError, Database> =>
  executeMembershipRevision(command);

export const reinstateOrganizationMembership = (
  command: Extract<MembershipRevisionCommand, { readonly _tag: "ReinstateMembership" }>,
): Effect.Effect<Membership, MembershipRevisionPersistenceError, Database> =>
  executeMembershipRevision(command);

const insertImportedOrganization = (
  sql: DatabaseShape,
  database: DatabaseShape,
  snapshot: LegacyOrganizationSnapshot,
  result: OrganizationImportResult,
): Effect.Effect<OrganizationImportResult, OrganizationPersistenceError> =>
  Effect.gen(function* () {
    const quarantined: OrganizationQuarantine[] = [...result.quarantined];
    const ledger: OrganizationImportLedgerEntry[] = [...result.ledger];
    const destinationCollisions = new Set<string>();
    const quarantineCollision = (
      sourceKind: OrganizationQuarantine["sourceKind"],
      destinationIdentity: string,
    ): Effect.Effect<void, OrganizationPersistenceError> => {
      const index = ledger.findIndex(
        (entry) =>
          entry.sourceKind === sourceKind &&
          entry.destinationIdentity === destinationIdentity &&
          entry.result === "Accepted",
      );
      const entry = ledger[index];
      if (entry === undefined) {
        return Effect.fail(
          persistenceError("classify organization destination collision", destinationIdentity),
        );
      }
      quarantined.push({
        sourceKind,
        sourcePrimaryKey: entry.sourcePrimaryKey,
        sourceOccurrence: entry.sourceOccurrence,
        targetSemanticIdentity: entry.targetSemanticIdentity,
        reason: "DESTINATION_IDENTITY_COLLISION",
        raw: entry.sourceRaw,
      });
      destinationCollisions.add(`${sourceKind}:${destinationIdentity}`);
      ledger[index] = {
        ...entry,
        destinationIdentity: null,
        result: "Quarantined",
        reason: "DESTINATION_IDENTITY_COLLISION",
      };
      return Effect.void;
    };
    yield* Effect.forEach(result.departments, (department) =>
      sql<{ readonly persisted_id: string }>`
          INSERT INTO organization_departments (
            department_id, name, short_name, email, address, city, latitude, longitude,
            slack_channel, logo_path, active, revision
          ) VALUES (
            ${department.departmentId}, ${department.name}, ${department.shortName}, ${department.email},
            ${department.address}, ${department.city}, ${department.latitude}, ${department.longitude},
            ${department.slackChannel}, ${department.logoPath}, ${department.active}, 0
          ) ON CONFLICT (department_id) DO UPDATE
            SET department_id = EXCLUDED.department_id
            WHERE organization_departments IS NOT DISTINCT FROM EXCLUDED
          RETURNING department_id AS persisted_id
        `.pipe(
        Effect.flatMap((rows) =>
          rows.length === 1
            ? Effect.void
            : quarantineCollision("department", department.departmentId),
        ),
      ),
    );
    yield* Effect.forEach(result.teams, (team) =>
      sql<{ readonly persisted_id: string }>`
          INSERT INTO organization_teams (
            team_id, department_id, name, email, description, short_description,
            accept_application, deadline, active, revision
          ) VALUES (
            ${team.teamId}, ${team.departmentId}, ${team.name}, ${team.email}, ${team.description},
            ${team.shortDescription}, ${team.acceptApplication}, ${team.deadline}, ${team.active}, 0
          ) ON CONFLICT (team_id) DO UPDATE
            SET team_id = EXCLUDED.team_id
            WHERE organization_teams IS NOT DISTINCT FROM EXCLUDED
          RETURNING team_id AS persisted_id
        `.pipe(
        Effect.flatMap((rows) =>
          rows.length === 1 ? Effect.void : quarantineCollision("team", team.teamId),
        ),
      ),
    );
    yield* Effect.forEach(result.memberships, (membership) =>
      sql<{ readonly persisted_id: string }>`
          INSERT INTO organization_memberships (
            membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
            position_id, is_team_leader, is_suspended, revision
          ) VALUES (
            ${membership.membershipId}, ${membership.personId}, ${membership.teamId}, ${membership.deletedTeamName},
            ${membership.startAt}, ${membership.endAt}, ${membership.positionId},
            ${membership.isTeamLeader}, ${membership.isSuspended}, 0
          ) ON CONFLICT DO NOTHING
          RETURNING membership_id AS persisted_id
        `.pipe(
        Effect.flatMap((rows) => {
          if (rows.length === 1) return Effect.void;
          return sql<{ readonly persisted_id: string }>`
            SELECT membership_id AS persisted_id
            FROM organization_memberships
            WHERE membership_id = ${membership.membershipId}
              AND person_id = ${membership.personId}
              AND team_id IS NOT DISTINCT FROM ${membership.teamId}
              AND deleted_team_name IS NOT DISTINCT FROM ${membership.deletedTeamName}
              AND start_at = ${membership.startAt}
              AND end_at IS NOT DISTINCT FROM ${membership.endAt}
              AND position_id IS NOT DISTINCT FROM ${membership.positionId}
              AND is_team_leader = ${membership.isTeamLeader}
              AND is_suspended = ${membership.isSuspended}
              AND revision = 0
          `.pipe(
            Effect.flatMap((exact) =>
              exact.length === 1
                ? Effect.void
                : quarantineCollision("membership", membership.membershipId),
            ),
          );
        }),
      ),
    );
    yield* Effect.forEach(
      quarantined,
      (row) =>
        sql`
        INSERT INTO organization_membership_quarantine (
          source_repository, source_revision, snapshot_id, source_primary_key, source_occurrence,
          transformation_revision, source_kind, target_semantic_identity, reason, raw_json
        ) VALUES (
          ${snapshot.sourceRepository}, ${snapshot.sourceRevision}, ${snapshot.snapshotId},
          ${row.sourcePrimaryKey}, ${row.sourceOccurrence}, ${snapshot.transformationRevision},
          ${row.sourceKind}, ${row.targetSemanticIdentity}, ${row.reason},
          ${database.json(row.raw)}
        ) ON CONFLICT (
          source_repository, source_revision, snapshot_id, source_kind, source_primary_key,
          source_occurrence, transformation_revision
        )
        DO NOTHING
      `,
    );
    yield* Effect.forEach(
      ledger,
      (entry) =>
        sql`
        INSERT INTO organization_import_ledger (
          source_repository, source_revision, snapshot_id, source_kind, source_primary_key,
          source_occurrence, transformation_revision, target_semantic_identity,
          destination_identity, result, reason_json, source_metadata_json
        ) VALUES (
          ${entry.sourceRepository}, ${entry.sourceRevision}, ${entry.snapshotId}, ${entry.sourceKind},
          ${entry.sourcePrimaryKey}, ${entry.sourceOccurrence}, ${entry.transformationRevision},
          ${entry.targetSemanticIdentity}, ${entry.destinationIdentity}, ${entry.result},
          ${entry.reason === null ? null : database.json({ code: entry.reason })},
          ${entry.sourceMetadata === null ? null : database.json(entry.sourceMetadata)}
        ) ON CONFLICT (
          source_repository, source_revision, snapshot_id, source_kind, source_primary_key,
          source_occurrence, transformation_revision
        ) DO NOTHING
      `,
    );
    return {
      departments: result.departments.filter(
        (department) => !destinationCollisions.has(`department:${department.departmentId}`),
      ),
      teams: result.teams.filter((team) => !destinationCollisions.has(`team:${team.teamId}`)),
      memberships: result.memberships.filter(
        (membership) => !destinationCollisions.has(`membership:${membership.membershipId}`),
      ),
      quarantined,
      ledger,
    };
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("persist organization import", cause)),
    ),
  );

export const importOrganizationSnapshot = (
  snapshot: LegacyOrganizationSnapshot,
): Effect.Effect<
  OrganizationImportResult,
  OrganizationImportError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const database = yield* Database;
    const classified = yield* importLegacyOrganizationEffect(snapshot);
    return yield* database
      .withTransaction(insertImportedOrganization(database, database, snapshot, classified))
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("organization import transaction", cause)),
        ),
      );
  });

const decodeTeamInterestRegistration = (
  row: unknown,
): Effect.Effect<TeamInterestRegistration, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(TeamInterestRegistration)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationDecodeError({
          operation: "decode TeamInterestRegistration select",
          message: String(cause),
        }),
    ),
  );

const teamInterestScopeClause = (
  database: DatabaseShape,
  authorizedDepartmentIds: ReadonlyArray<DepartmentId>,
) =>
  Statement.or(
    authorizedDepartmentIds.map(
      (departmentId) => database`registration.department_id = ${departmentId}`,
    ),
  );

const optionalTeamInterestFilters = (
  database: DatabaseShape,
  filter: TeamInterestFilter,
): Statement.Fragment => {
  const clauses: Array<Statement.Fragment> = [];
  if (filter.semesterId !== undefined) {
    clauses.push(database`registration.semester_id = ${filter.semesterId}`);
  }
  if (filter.departmentId !== undefined) {
    clauses.push(database`registration.department_id = ${filter.departmentId}`);
  }
  return clauses.length === 0 ? Statement.fragment([]) : Statement.and(clauses);
};

export const listOrganizationTeamInterestRegistrations = (
  filter: TeamInterestFilter,
): Effect.Effect<
  ReadonlyArray<TeamInterestRegistration>,
  OrganizationDecodeError | OrganizationPersistenceError,
  Database
> => {
  if (filter.authorizedDepartmentIds.length === 0) return Effect.succeed([]);
  return Effect.gen(function* () {
    const database = yield* Database;
    const rows = yield* database<TeamInterestRegistrationSelect>`
      SELECT
        registration.registration_id::text AS "registrationId",
        registration.submitter_name AS "submitterName",
        registration.submitter_email AS "submitterEmail",
        registration.team_id AS "teamId",
        team.name AS "teamName",
        registration.department_id AS "departmentId",
        registration.semester_id AS "semesterId",
        to_char(registration.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          AS "submittedAt",
        registration.revision
      FROM organization_team_interest_registrations AS registration
      INNER JOIN organization_teams AS team
        ON team.team_id = registration.team_id
      WHERE ${teamInterestScopeClause(database, filter.authorizedDepartmentIds)}
        AND ${optionalTeamInterestFilters(database, filter)}
      ORDER BY registration.registration_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(
          persistenceError("list organization team interest registrations", cause),
        ),
      ),
    );
    return yield* Effect.forEach(rows, decodeTeamInterestRegistration);
  });
};
