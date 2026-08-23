import { Database, type DatabaseShape } from "../database/service.js";
import { Effect, Schema } from "effect";
import {
  DepartmentNotFound,
  MembershipInvalidInterval,
  MembershipNotFound,
  MembershipRevisionConflict,
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
  type MembershipSelect,
  type DepartmentId,
  type MembershipId,
  type TeamId,
} from "./schema.js";
import {
  importLegacyOrganization,
  type LegacyOrganizationSnapshot,
  type OrganizationImportResult,
} from "./import.js";
import {
  applyMembershipRevision,
  type MembershipRevisionCommand,
} from "./transitions.js";

const persistenceError = (operation: string, cause: unknown) =>
  new OrganizationPersistenceError({ operation, message: String(cause) });

const decodeDepartment = (
  row: unknown,
): Effect.Effect<Department, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(Department)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationDecodeError({ operation: "decode Department select", message: String(cause) }),
    ),
  );

const decodeTeam = (row: unknown): Effect.Effect<Team, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(Team)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) => new OrganizationDecodeError({ operation: "decode Team select", message: String(cause) }),
    ),
  );

const decodeMembership = (
  row: unknown,
): Effect.Effect<Membership, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(Membership)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationDecodeError({ operation: "decode Membership select", message: String(cause) }),
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
    Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeed(undefined) : decodeDepartment(rows[0]))),
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("read organization department", cause))),
  );

export const readOrganizationDepartment = (
  departmentId: DepartmentId,
): Effect.Effect<Department, DepartmentNotFound | OrganizationDecodeError | OrganizationPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const department = yield* findDepartment(sql, departmentId);
    return department === undefined
      ? yield* new DepartmentNotFound({ departmentId })
      : department;
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
        ELSE to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      END AS deadline,
      active,
      revision
    FROM organization_teams
    WHERE team_id = ${teamId}
  `.pipe(
    Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeed(undefined) : decodeTeam(rows[0]))),
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("read organization team", cause))),
  );

export const readOrganizationTeam = (
  teamId: TeamId,
): Effect.Effect<Team, TeamNotFound | OrganizationDecodeError | OrganizationPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const team = yield* findTeam(sql, teamId);
    return team === undefined ? yield* new TeamNotFound({ teamId }) : team;
  });

export const listOrganizationTeams = (
  departmentId?: DepartmentId,
): Effect.Effect<ReadonlyArray<Team>, OrganizationDecodeError | OrganizationPersistenceError, Database> =>
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
                ELSE to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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
                ELSE to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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
): Effect.Effect<Membership | undefined, OrganizationDecodeError | OrganizationPersistenceError> => {
  const query = forUpdate
    ? sql<MembershipSelect>`
        SELECT
          membership_id AS "membershipId",
          person_id AS "personId",
          team_id AS "teamId",
          deleted_team_name AS "deletedTeamName",
          to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startAt",
          CASE WHEN end_at IS NULL THEN NULL
            ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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
          to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startAt",
          CASE WHEN end_at IS NULL THEN NULL
            ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
          END AS "endAt",
          position_id AS "positionId",
          is_team_leader AS "isTeamLeader",
          is_suspended AS "isSuspended",
          revision
        FROM organization_memberships
        WHERE membership_id = ${membershipId}
      `;
  return query.pipe(
    Effect.flatMap((rows) => (rows[0] === undefined ? Effect.succeed(undefined) : decodeMembership(rows[0]))),
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("read organization membership", cause))),
  );
};

export const listOrganizationMembershipsForTeam = (
  teamId: TeamId,
): Effect.Effect<ReadonlyArray<Membership>, OrganizationDecodeError | OrganizationPersistenceError, Database> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<MembershipSelect>`
      SELECT
        membership_id AS "membershipId",
        person_id AS "personId",
        team_id AS "teamId",
        deleted_team_name AS "deletedTeamName",
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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
        to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startAt",
        CASE WHEN end_at IS NULL THEN NULL
          ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
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
): Effect.Effect<Membership, OrganizationPersistenceError | MembershipRevisionConflict> =>
  sql<MembershipSelect>`
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
      to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startAt",
      CASE WHEN end_at IS NULL THEN NULL
        ELSE to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      END AS "endAt",
      position_id AS "positionId",
      is_team_leader AS "isTeamLeader",
      is_suspended AS "isSuspended",
      revision
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0] === undefined
        ? Effect.fail(new MembershipRevisionConflict({ membershipId: current.membershipId }))
        : decodeMembership(rows[0]),
    ),
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
    return yield* database.withTransaction(
      Effect.gen(function* () {
        const current = yield* findMembership(database, command.membershipId, true);
        if (current === undefined) return yield* new MembershipNotFound({ membershipId: command.membershipId });
        const next = yield* applyMembershipRevision(current, command);
        return yield* updateMembership(database, current, next);
      }),
    ).pipe(
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
): Effect.Effect<void, OrganizationPersistenceError> =>
  Effect.gen(function* () {
    yield* Effect.forEach(result.departments, (department) =>
      sql`
        INSERT INTO organization_departments (
          department_id, name, short_name, email, address, city, latitude, longitude,
          slack_channel, logo_path, active, revision
        ) VALUES (
          ${department.departmentId}, ${department.name}, ${department.shortName}, ${department.email},
          ${department.address}, ${department.city}, ${department.latitude}, ${department.longitude},
          ${department.slackChannel}, ${department.logoPath}, ${department.active}, 0
        ) ON CONFLICT (department_id) DO NOTHING
      `,
    );
    yield* Effect.forEach(result.teams, (team) =>
      sql`
        INSERT INTO organization_teams (
          team_id, department_id, name, email, description, short_description,
          accept_application, deadline, active, revision
        ) VALUES (
          ${team.teamId}, ${team.departmentId}, ${team.name}, ${team.email}, ${team.description},
          ${team.shortDescription}, ${team.acceptApplication}, ${team.deadline}, ${team.active}, 0
        ) ON CONFLICT (team_id) DO NOTHING
      `,
    );
    yield* Effect.forEach(result.memberships, (membership) =>
      sql`
        INSERT INTO organization_memberships (
          membership_id, person_id, team_id, deleted_team_name, start_at, end_at,
          position_id, is_team_leader, is_suspended, revision
        ) VALUES (
          ${membership.membershipId}, ${membership.personId}, ${membership.teamId}, ${membership.deletedTeamName},
          ${membership.startAt}, ${membership.endAt}, ${membership.positionId},
          ${membership.isTeamLeader}, ${membership.isSuspended}, 0
        ) ON CONFLICT (membership_id) DO NOTHING
      `,
    );
    yield* Effect.forEach(result.quarantined, (row) =>
      sql`
        INSERT INTO organization_membership_quarantine (
          source_repository, source_revision, snapshot_id, source_primary_key,
          transformation_revision, source_kind, target_semantic_identity, reason, raw_json
        ) VALUES (
          ${snapshot.sourceRepository}, ${snapshot.sourceRevision}, ${snapshot.snapshotId},
          ${row.sourcePrimaryKey}, ${snapshot.transformationRevision}, ${row.sourceKind},
          ${row.sourceKind + ":" + row.sourcePrimaryKey}, ${row.reason}, ${database.json(row.raw)}
        ) ON CONFLICT (
          source_repository, source_revision, snapshot_id, source_kind, source_primary_key, transformation_revision
        )
        DO NOTHING
      `,
    );
    yield* Effect.forEach(result.ledger, (entry) =>
      sql`
        INSERT INTO organization_import_ledger (
          source_repository, source_revision, snapshot_id, source_primary_key,
          transformation_revision, target_semantic_identity, destination_identity,
          result, reason
        ) VALUES (
          ${entry.sourceRepository}, ${entry.sourceRevision}, ${entry.snapshotId}, ${entry.sourcePrimaryKey},
          ${entry.transformationRevision}, ${entry.targetSemanticIdentity}, ${entry.destinationIdentity},
          ${entry.result}, ${entry.reason}
        ) ON CONFLICT (
          source_repository, source_revision, snapshot_id, source_primary_key, transformation_revision
        ) DO NOTHING
      `,
    );
  }).pipe(
    Effect.asVoid,
    Effect.catchTag("SqlError", (cause) => Effect.fail(persistenceError("persist organization import", cause))),
  );

export const importOrganizationSnapshot = (
  snapshot: LegacyOrganizationSnapshot,
): Effect.Effect<OrganizationImportResult, OrganizationImportError | OrganizationPersistenceError, Database> =>
  Effect.gen(function* () {
    const database = yield* Database;
    const result = importLegacyOrganization(snapshot);
    yield* database.withTransaction(insertImportedOrganization(database, database, snapshot, result)).pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("organization import transaction", cause)),
      ),
    );
    return result;
  });
