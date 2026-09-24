import { isIP } from "node:net";
import { Schema } from "effect";
import { createConnection, type Connection, type RowDataPacket } from "mysql2/promise";
import type { LegacyUserJson } from "./legacy-person-snapshot";

const SourceId = Schema.Union([
  Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9][0-9]*$/))),
]);

const TextOrNull = Schema.NullOr(Schema.String);

const Flag = Schema.Union([Schema.Int, Schema.String, Schema.Boolean]);

const Credential = Schema.Struct({ id: SourceId, passwordHash: TextOrNull });

const Department = Schema.Struct({
  id: SourceId,
  name: Schema.String,
  shortName: Schema.String,
  email: Schema.String,
  address: TextOrNull,
  city: Schema.String,
  latitude: TextOrNull,
  longitude: TextOrNull,
  slackChannel: TextOrNull,
  logoPath: TextOrNull,
  active: Flag,
});

const Semester = Schema.Struct({
  id: SourceId,
  semesterTime: Schema.String,
  year: Schema.String,
});

const School = Schema.Struct({
  id: SourceId,
  name: Schema.String,
  contactPerson: Schema.String,
  email: Schema.String,
  phone: Schema.String,
  international: Flag,
  active: Flag,
});

const Relationship = Schema.Struct({ departmentId: SourceId, schoolId: SourceId });

const History = Schema.Struct({
  id: SourceId,
  userId: Schema.NullOr(SourceId),
  departmentId: Schema.NullOr(SourceId),
  semesterId: Schema.NullOr(SourceId),
  schoolId: Schema.NullOr(SourceId),
  workdays: TextOrNull,
  bolk: TextOrNull,
  day: TextOrNull,
});

export type LegacyDepartment = typeof Department.Type;

export type LegacySemester = typeof Semester.Type;

export type LegacySchool = typeof School.Type;

export type LegacyRelationship = typeof Relationship.Type;

export type LegacyCredential = typeof Credential.Type;

export type LegacyHistory = typeof History.Type;

const NullableSourceId = Schema.NullOr(SourceId);
const NullableFlag = Schema.NullOr(Flag);

const Team = Schema.Struct({
  id: SourceId,
  departmentId: NullableSourceId,
  name: TextOrNull,
  active: NullableFlag,
});

const Position = Schema.Struct({ id: SourceId, name: TextOrNull });

const TeamMembership = Schema.Struct({
  id: SourceId,
  userId: NullableSourceId,
  teamId: NullableSourceId,
  positionId: NullableSourceId,
  startSemesterId: NullableSourceId,
  endSemesterId: NullableSourceId,
  isTeamLeader: NullableFlag,
  isSuspended: NullableFlag,
  deletedTeamName: TextOrNull,
});

const ExecutiveBoard = Schema.Struct({ id: SourceId, name: TextOrNull });

const ExecutiveBoardMembership = Schema.Struct({
  id: SourceId,
  userId: NullableSourceId,
  boardId: NullableSourceId,
  positionName: TextOrNull,
  startSemesterId: NullableSourceId,
  endSemesterId: NullableSourceId,
});

export type LegacyTeam = typeof Team.Type;
export type LegacyPosition = typeof Position.Type;
export type LegacyTeamMembership = typeof TeamMembership.Type;
export type LegacyExecutiveBoard = typeof ExecutiveBoard.Type;
export type LegacyExecutiveBoardMembership = typeof ExecutiveBoardMembership.Type;
export type LegacyOrganizationSelection = "NotRequested" | "Include";

export interface LegacySourceSnapshot {
  readonly users: ReadonlyArray<LegacyUserJson>;
  readonly credentials: ReadonlyArray<LegacyCredential>;
  readonly departments: ReadonlyArray<LegacyDepartment>;
  readonly semesters: ReadonlyArray<LegacySemester>;
  readonly schools: ReadonlyArray<LegacySchool>;
  readonly relationships: ReadonlyArray<LegacyRelationship>;
  readonly history: ReadonlyArray<LegacyHistory>;
  readonly teams?: ReadonlyArray<LegacyTeam>;
  readonly positions?: ReadonlyArray<LegacyPosition>;
  readonly teamMemberships?: ReadonlyArray<LegacyTeamMembership>;
  readonly executiveBoards?: ReadonlyArray<LegacyExecutiveBoard>;
  readonly executiveBoardMemberships?: ReadonlyArray<LegacyExecutiveBoardMembership>;
}

const sourceTables = [
  "user",
  "department",
  "semester",
  "school",
  "department_school",
  "assistant_history",
];

const organizationTables = [
  "team",
  "position",
  "team_membership",
  "executive_board",
  "executive_board_membership",
];

const select = async <T extends RowDataPacket>(
  connection: Connection,
  sql: string,
): Promise<T[]> => {
  const [rows] = await connection.query<T[]>(sql);

  return rows;
};

// Roles and grants with any privilege other than SELECT/USAGE are deliberately refused.
// Never include a SHOW GRANTS result, SQL error, or URL in an exception or report.
export const assertSelectOnlyGrants = (grants: ReadonlyArray<string>, database: string): void => {
  if (grants.length === 0) throw new Error("Source grants are not SELECT-only");

  for (const grant of grants) {
    const match =
      /^GRANT (USAGE|SELECT) ON (\*\.\*|`?([A-Za-z0-9_]+)`?\.(?:\*|`?[A-Za-z0-9_]+`?)) TO /i.exec(
        grant,
      );

    if (
      !match ||
      /\bWITH GRANT OPTION\b/i.test(grant) ||
      (match[1]?.toUpperCase() === "USAGE" && match[2] !== "*.*") ||
      (match[1]?.toUpperCase() === "SELECT" && match[2] === "*.*")
    )
      throw new Error("Source grants are not SELECT-only for the chosen database");

    if (match[3] !== undefined && match[3] !== database)
      throw new Error("Source grants are not SELECT-only for the chosen database");
  }
};

/** All selected InnoDB tables share one read-only snapshot. Omission retains the six-table shape. */
export const readLegacySourceSnapshot = async (
  sourceUrl: string,
  organization: LegacyOrganizationSelection = "NotRequested",
): Promise<LegacySourceSnapshot> => {
  if (organization !== "NotRequested" && organization !== "Include")
    throw new Error("Explicit organization source selection is invalid");
  const selectedTables =
    organization === "Include" ? [...sourceTables, ...organizationTables] : sourceTables;
  const url = (() => {
    try {
      return new URL(sourceUrl);
    } catch {
      throw new Error("Source connection selection is invalid");
    }
  })();

  const database = decodeURIComponent(url.pathname.slice(1));

  if (url.protocol !== "mysql:" || !/^[A-Za-z0-9_]+$/.test(database) || !url.username)
    throw new Error("Source connection selection is invalid");
  const socketPath = url.searchParams.get("socketPath");
  const sslCaEnv = url.searchParams.get("sslCaEnv");

  if ([...url.searchParams.keys()].some((key) => !["socketPath", "sslCaEnv"].includes(key)))
    throw new Error("Source transport options are not permitted");

  if (socketPath !== null && (!socketPath.startsWith("/") || sslCaEnv !== null))
    throw new Error("Local source socket selection is invalid");

  if (
    socketPath === null &&
    (!sslCaEnv ||
      !/^[A-Z][A-Z0-9_]*$/.test(sslCaEnv) ||
      !process.env[sslCaEnv] ||
      !url.hostname ||
      isIP(url.hostname) !== 0)
  )
    throw new Error("Remote source requires a verified TLS CA and DNS identity");

  const connection = await createConnection({
    host: socketPath ? undefined : url.hostname,
    port: url.port ? Number(url.port) : undefined,
    socketPath: socketPath ?? undefined,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: socketPath
      ? undefined
      : { ca: process.env[sslCaEnv!], rejectUnauthorized: true, verifyIdentity: true },
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  }).catch(() => {
    throw new Error("Legacy source Connection failed; details redacted");
  });

  let stage = "Grants";

  try {
    const grants = await select<RowDataPacket>(connection, "SHOW GRANTS FOR CURRENT_USER()");
    assertSelectOnlyGrants(
      grants.map((row) => String(Object.values(row)[0])),
      database,
    );
    stage = "DatabaseSelection";
    const selected = await select<RowDataPacket>(connection, "SELECT DATABASE() AS name");

    if (selected[0]?.name !== database) throw new Error("Source database differs from selection");
    stage = "Transaction";
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");

    try {
      stage = "Engines";

      const engines = await select<RowDataPacket>(
        connection,
        `SELECT table_name AS tableName, engine
           FROM information_schema.tables
          WHERE table_schema = DATABASE()
            AND table_name IN (${selectedTables.map((table) => `'${table}'`).join(",")})`,
      );

      if (
        engines.length !== selectedTables.length ||
        engines.some(
          (row) => !selectedTables.includes(String(row.tableName)) || row.engine !== "InnoDB",
        )
      )
        throw new Error("Source tables must all use InnoDB");
      stage = "Users";

      const users = await select<RowDataPacket & LegacyUserJson>(
        connection,
        `SELECT id, is_active AS active, firstName, lastName, email, phone,
                user_name AS username, companyEmail
           FROM user ORDER BY id`,
      );

      stage = "Credentials";

      const credentials = Schema.decodeUnknownSync(Schema.Array(Credential))(
        await select<RowDataPacket>(
          connection,
          "SELECT id, password AS passwordHash FROM user ORDER BY id",
        ),
      );

      if (
        credentials.length !== users.length ||
        users.some((user, index) => String(user.id) !== String(credentials[index]?.id))
      )
        throw new Error("Credential rows differ from users");
      stage = "Departments";

      const departments = Schema.decodeUnknownSync(Schema.Array(Department))(
        await select<RowDataPacket>(
          connection,
          `SELECT id, name, short_name AS shortName, email, address, city,
                  latitude, longitude, slackChannel, logo_path AS logoPath, active
             FROM department ORDER BY id`,
        ),
      );

      stage = "Semesters";

      const semesters = Schema.decodeUnknownSync(Schema.Array(Semester))(
        await select<RowDataPacket>(
          connection,
          "SELECT id, semesterTime, year FROM semester ORDER BY id",
        ),
      );

      stage = "Schools";

      const schools = Schema.decodeUnknownSync(Schema.Array(School))(
        await select<RowDataPacket>(
          connection,
          `SELECT id, name, contactPerson, email, phone, international, active
             FROM school ORDER BY id`,
        ),
      );

      stage = "Relationships";

      const relationships = Schema.decodeUnknownSync(Schema.Array(Relationship))(
        await select<RowDataPacket>(
          connection,
          `SELECT department_id AS departmentId, school_id AS schoolId
             FROM department_school ORDER BY department_id, school_id`,
        ),
      );

      stage = "History";

      const history = Schema.decodeUnknownSync(Schema.Array(History))(
        await select<RowDataPacket>(
          connection,
          `SELECT id, user_id AS userId, department_id AS departmentId,
                  semester_id AS semesterId, school_id AS schoolId, workdays, bolk, day
             FROM assistant_history ORDER BY id`,
        ),
      );

      const source = { users, credentials, departments, semesters, schools, relationships, history };

      if (organization === "NotRequested") {
        await connection.query("COMMIT");
        return source;
      }

      stage = "Teams";
      const teams = Schema.decodeUnknownSync(Schema.Array(Team))(
        await select<RowDataPacket>(
          connection,
          "SELECT id, department_id AS departmentId, name, active FROM team ORDER BY id",
        ),
      );
      stage = "Positions";
      const positions = Schema.decodeUnknownSync(Schema.Array(Position))(
        await select<RowDataPacket>(connection, "SELECT id, name FROM position ORDER BY id"),
      );
      stage = "TeamMemberships";
      const teamMemberships = Schema.decodeUnknownSync(Schema.Array(TeamMembership))(
        await select<RowDataPacket>(
          connection,
          `SELECT id, user_id AS userId, team_id AS teamId, position_id AS positionId,
                  startSemester_id AS startSemesterId, endSemester_id AS endSemesterId,
                  isTeamLeader, isSuspended, deletedTeamName
             FROM team_membership ORDER BY id`,
        ),
      );
      stage = "ExecutiveBoards";
      const executiveBoards = Schema.decodeUnknownSync(Schema.Array(ExecutiveBoard))(
        await select<RowDataPacket>(connection, "SELECT id, name FROM executive_board ORDER BY id"),
      );
      stage = "ExecutiveBoardMemberships";
      const executiveBoardMemberships = Schema.decodeUnknownSync(Schema.Array(ExecutiveBoardMembership))(
        await select<RowDataPacket>(
          connection,
          `SELECT id, user_id AS userId, board_id AS boardId, positionName,
                  startSemester_id AS startSemesterId, endSemester_id AS endSemesterId
             FROM executive_board_membership ORDER BY id`,
        ),
      );
      await connection.query("COMMIT");
      return { ...source, teams, positions, teamMemberships, executiveBoards, executiveBoardMemberships };
    } catch {
      await connection.query("ROLLBACK");
      throw new Error("Legacy source " + stage + " failed; details redacted");
    }
  } catch {
    throw new Error("Legacy source " + stage + " failed; details redacted");
  } finally {
    await connection.end().catch(() => {
      throw new Error("Legacy source Close failed; details redacted");
    });
  }
};
