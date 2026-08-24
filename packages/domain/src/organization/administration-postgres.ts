import { Database, type DatabaseShape } from "../database/service.js";
import { canonicalJson } from "../tutor/evidence.js";
import { Effect, Schema } from "effect";
import {
  authorizeOrganizationActor,
  decodeCreateDepartmentCommand,
  decodeCreateFieldOfStudyCommand,
  decodeCreateTeamCommand,
  decodeOrganizationActor,
  departmentIdForCommand,
  fieldOfStudyIdForCommand,
  organizationCommandDigest,
  teamIdForCommand,
} from "./administration.js";
import {
  DepartmentCreatedObservationSchema,
  FieldOfStudyCreatedObservationSchema,
  TeamCreatedObservationSchema,
  type CreateDepartmentCommand,
  type CreateDepartmentResult,
  type CreateFieldOfStudyCommand,
  type CreateFieldOfStudyResult,
  type CreateTeamCommand,
  type CreateTeamResult,
  type DepartmentCreatedObservation,
  type FieldOfStudyCreatedObservation,
  type OrganizationActor,
  type OrganizationCommandId,
  type OrganizationCreateCommand,
  type OrganizationCreatedObservation,
  type OrganizationEntityKind,
  type TeamCreatedObservation,
} from "./administration-schema.js";
import {
  OrganizationCommandConflict,
  OrganizationDecodeError,
  OrganizationInvalidReference,
  OrganizationPersistenceError,
  type OrganizationCommandFailure,
} from "./errors.js";
import {
  Department,
  FieldOfStudy,
  Team,
  type DepartmentId,
  type DepartmentSelect,
  type FieldOfStudyId,
  type FieldOfStudySelect,
  type TeamId,
  type TeamSelect,
} from "./schema.js";

interface OrganizationCommandReceiptRow {
  readonly commandSha256: string;
  readonly entityKind: OrganizationEntityKind;
  readonly entityId: string;
  readonly observationJson: unknown;
}

interface ExistsRow {
  readonly exists: boolean;
}

const persistenceError = (operation: string, cause?: unknown) =>
  new OrganizationPersistenceError({
    operation,
    message: cause === undefined ? operation : String(cause),
  });

const decodeError = (operation: string, cause: unknown) =>
  new OrganizationDecodeError({ operation, message: String(cause) });

const decodeDepartment = (row: unknown): Effect.Effect<Department, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(Department)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => decodeError("decode created Department", cause)),
  );

const decodeTeam = (row: unknown): Effect.Effect<Team, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(Team)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => decodeError("decode created Team", cause)),
  );

const decodeFieldOfStudy = (
  row: unknown,
): Effect.Effect<FieldOfStudy, OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(FieldOfStudy)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError((cause) => decodeError("decode created FieldOfStudy", cause)),
  );

const lockCommand = (sql: DatabaseShape, commandId: OrganizationCommandId) =>
  sql`SELECT pg_advisory_xact_lock(hashtextextended(${commandId}, 0))`.pipe(Effect.asVoid);

const readReceipt = (sql: DatabaseShape, commandId: OrganizationCommandId) =>
  sql<OrganizationCommandReceiptRow>`
    SELECT
      command_sha256 AS "commandSha256",
      entity_kind AS "entityKind",
      entity_id AS "entityId",
      observation_json AS "observationJson"
    FROM organization_command_receipts
    WHERE command_id = ${commandId}
  `.pipe(Effect.map((rows) => rows[0]));

const requireDepartment = (sql: DatabaseShape, departmentId: DepartmentId) =>
  sql<ExistsRow>`
    SELECT EXISTS (
      SELECT 1
      FROM organization_departments
      WHERE department_id = ${departmentId}
    ) AS "exists"
  `.pipe(
    Effect.flatMap((rows) =>
      rows[0]?.exists === true
        ? Effect.void
        : Effect.fail(new OrganizationInvalidReference({ referenceKind: "Department" })),
    ),
  );

const readDepartment = (
  sql: DatabaseShape,
  departmentId: DepartmentId,
): Effect.Effect<Department, OrganizationDecodeError | OrganizationPersistenceError> =>
  Effect.gen(function* () {
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
      WHERE department_id = ${departmentId}
    `;
    const row = rows[0];
    if (row === undefined) return yield* persistenceError("read created Department");
    return yield* decodeDepartment(row);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read created Department", cause)),
    ),
  );

const readTeam = (
  sql: DatabaseShape,
  teamId: TeamId,
): Effect.Effect<Team, OrganizationDecodeError | OrganizationPersistenceError> =>
  Effect.gen(function* () {
    const rows = yield* sql<TeamSelect>`
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
    `;
    const row = rows[0];
    if (row === undefined) return yield* persistenceError("read created Team");
    return yield* decodeTeam(row);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read created Team", cause)),
    ),
  );

const readFieldOfStudy = (
  sql: DatabaseShape,
  fieldOfStudyId: FieldOfStudyId,
): Effect.Effect<FieldOfStudy, OrganizationDecodeError | OrganizationPersistenceError> =>
  Effect.gen(function* () {
    const rows = yield* sql<FieldOfStudySelect>`
      SELECT
        field_of_study_id AS "fieldOfStudyId",
        name,
        short_name AS "shortName",
        department_id AS "departmentId",
        active,
        revision
      FROM organization_field_of_studies
      WHERE field_of_study_id = ${fieldOfStudyId}
    `;
    const row = rows[0];
    if (row === undefined) return yield* persistenceError("read created FieldOfStudy");
    return yield* decodeFieldOfStudy(row);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("read created FieldOfStudy", cause)),
    ),
  );

export const listOrganizationFieldOfStudies = (): Effect.Effect<
  ReadonlyArray<FieldOfStudy>,
  OrganizationDecodeError | OrganizationPersistenceError,
  Database
> =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<FieldOfStudySelect>`
      SELECT
        field_of_study_id AS "fieldOfStudyId",
        name,
        short_name AS "shortName",
        department_id AS "departmentId",
        active,
        revision
      FROM organization_field_of_studies
      ORDER BY field_of_study_id ASC
    `.pipe(
      Effect.catchTag("SqlError", (cause) =>
        Effect.fail(persistenceError("list organization fields of study", cause)),
      ),
    );
    return yield* Effect.forEach(rows, decodeFieldOfStudy);
  });

const storeReceiptAndAudit = (
  sql: DatabaseShape,
  command: OrganizationCreateCommand,
  digest: string,
  entityKind: OrganizationEntityKind,
  entityId: string,
  actor: OrganizationActor,
  observation: OrganizationCreatedObservation,
) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO organization_command_receipts (
        command_id,
        command_sha256,
        command_json,
        observation_json,
        entity_kind,
        entity_id,
        actor_json,
        actor_person_id,
        committed_at
      ) VALUES (
        ${command.commandId},
        ${digest},
        ${sql.json(command)},
        ${sql.json(observation)},
        ${entityKind},
        ${entityId},
        ${sql.json(actor)},
        ${actor.personId},
        CURRENT_TIMESTAMP
      )
    `;
    const action = `${entityKind}Created`;
    yield* sql`
      INSERT INTO organization_creation_audit (
        command_id,
        entity_kind,
        entity_id,
        actor_person_id,
        action,
        occurred_at
      )
      SELECT
        command_id,
        entity_kind,
        entity_id,
        actor_person_id,
        ${action},
        committed_at
      FROM organization_command_receipts
      WHERE command_id = ${command.commandId}
    `;
  });

const decodeDepartmentReplay = (
  commandId: OrganizationCommandId,
  receipt: OrganizationCommandReceiptRow,
): Effect.Effect<CreateDepartmentResult, OrganizationDecodeError | OrganizationPersistenceError> =>
  Schema.decodeUnknownEffect(DepartmentCreatedObservationSchema)(receipt.observationJson, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => decodeError("decode Department command receipt", cause)),
    Effect.flatMap((original) =>
      receipt.entityKind === "Department" &&
      receipt.entityId === original.department.departmentId &&
      original.commandId === commandId
        ? Effect.succeed({
            committed: false as const,
            observation: { _tag: "Replayed" as const, commandId, original },
          })
        : Effect.fail(persistenceError("validate Department command receipt linkage")),
    ),
  );

const decodeTeamReplay = (
  commandId: OrganizationCommandId,
  receipt: OrganizationCommandReceiptRow,
): Effect.Effect<CreateTeamResult, OrganizationDecodeError | OrganizationPersistenceError> =>
  Schema.decodeUnknownEffect(TeamCreatedObservationSchema)(receipt.observationJson, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => decodeError("decode Team command receipt", cause)),
    Effect.flatMap((original) =>
      receipt.entityKind === "Team" &&
      receipt.entityId === original.team.teamId &&
      original.commandId === commandId
        ? Effect.succeed({
            committed: false as const,
            observation: { _tag: "Replayed" as const, commandId, original },
          })
        : Effect.fail(persistenceError("validate Team command receipt linkage")),
    ),
  );

const decodeFieldOfStudyReplay = (
  commandId: OrganizationCommandId,
  receipt: OrganizationCommandReceiptRow,
): Effect.Effect<CreateFieldOfStudyResult, OrganizationDecodeError | OrganizationPersistenceError> =>
  Schema.decodeUnknownEffect(FieldOfStudyCreatedObservationSchema)(receipt.observationJson, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => decodeError("decode FieldOfStudy command receipt", cause)),
    Effect.flatMap((original) =>
      receipt.entityKind === "FieldOfStudy" &&
      receipt.entityId === original.fieldOfStudy.fieldOfStudyId &&
      original.commandId === commandId
        ? Effect.succeed({
            committed: false as const,
            observation: { _tag: "Replayed" as const, commandId, original },
          })
        : Effect.fail(persistenceError("validate FieldOfStudy command receipt linkage")),
    ),
  );

const receiptOrConflict = (
  receipt: OrganizationCommandReceiptRow | undefined,
  digest: string,
  commandId: OrganizationCommandId,
): Effect.Effect<OrganizationCommandReceiptRow | undefined, OrganizationCommandConflict> => {
  if (receipt === undefined || receipt.commandSha256 === digest) return Effect.succeed(receipt);
  return Effect.fail(new OrganizationCommandConflict({ commandId }));
};

const ensureCanonical = <A>(
  inserted: A,
  selected: A,
  operation: string,
): Effect.Effect<A, OrganizationPersistenceError> =>
  canonicalJson(inserted) === canonicalJson(selected)
    ? Effect.succeed(selected)
    : Effect.fail(persistenceError(operation));

const insertDepartment = (
  sql: DatabaseShape,
  command: CreateDepartmentCommand,
): Effect.Effect<Department, OrganizationDecodeError | OrganizationPersistenceError> => {
  const departmentId = departmentIdForCommand(command.commandId);
  return Effect.gen(function* () {
    const rows = yield* sql<DepartmentSelect>`
      INSERT INTO organization_departments (
        department_id,
        name,
        short_name,
        email,
        address,
        city,
        latitude,
        longitude,
        slack_channel,
        logo_path,
        active,
        revision,
        native_creation_command_id
      ) VALUES (
        ${departmentId},
        ${command.name},
        ${command.shortName},
        ${command.email},
        ${command.address},
        ${command.city},
        ${command.latitude},
        ${command.longitude},
        NULL,
        NULL,
        TRUE,
        0,
        ${command.commandId}
      )
      RETURNING
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
    `;
    const row = rows[0];
    if (row === undefined) return yield* persistenceError("insert Organization Department");
    return yield* decodeDepartment(row);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("insert Organization Department", cause)),
    ),
  );
};

const insertTeam = (
  sql: DatabaseShape,
  command: CreateTeamCommand,
): Effect.Effect<Team, OrganizationDecodeError | OrganizationPersistenceError> => {
  const teamId = teamIdForCommand(command.commandId);
  return Effect.gen(function* () {
    const rows = yield* sql<TeamSelect>`
      INSERT INTO organization_teams (
        team_id,
        department_id,
        name,
        email,
        description,
        short_description,
        accept_application,
        deadline,
        active,
        revision,
        native_creation_command_id
      ) VALUES (
        ${teamId},
        ${command.departmentId},
        ${command.name},
        ${command.email},
        ${command.description},
        ${command.shortDescription},
        ${command.acceptApplication},
        ${command.deadline},
        ${command.active},
        0,
        ${command.commandId}
      )
      RETURNING
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
    `;
    const row = rows[0];
    if (row === undefined) return yield* persistenceError("insert Organization Team");
    return yield* decodeTeam(row);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("insert Organization Team", cause)),
    ),
  );
};

const insertFieldOfStudy = (
  sql: DatabaseShape,
  command: CreateFieldOfStudyCommand,
): Effect.Effect<FieldOfStudy, OrganizationDecodeError | OrganizationPersistenceError> => {
  const fieldOfStudyId = fieldOfStudyIdForCommand(command.commandId);
  return Effect.gen(function* () {
    const rows = yield* sql<FieldOfStudySelect>`
      INSERT INTO organization_field_of_studies (
        field_of_study_id,
        name,
        short_name,
        department_id,
        active,
        revision,
        native_creation_command_id
      ) VALUES (
        ${fieldOfStudyId},
        ${command.name},
        ${command.shortName},
        ${command.departmentId},
        TRUE,
        0,
        ${command.commandId}
      )
      RETURNING
        field_of_study_id AS "fieldOfStudyId",
        name,
        short_name AS "shortName",
        department_id AS "departmentId",
        active,
        revision
    `;
    const row = rows[0];
    if (row === undefined) return yield* persistenceError("insert Organization FieldOfStudy");
    return yield* decodeFieldOfStudy(row);
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(persistenceError("insert Organization FieldOfStudy", cause)),
    ),
  );
};

export const createOrganizationDepartment = (
  commandInput: CreateDepartmentCommand,
  actorInput: OrganizationActor,
): Effect.Effect<CreateDepartmentResult, OrganizationCommandFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* decodeCreateDepartmentCommand(commandInput);
    const actor = yield* decodeOrganizationActor(actorInput);
    const sql = yield* Database;
    const digest = organizationCommandDigest(command);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockCommand(sql, command.commandId);
          const receipt = yield* readReceipt(sql, command.commandId).pipe(
            Effect.flatMap((stored) => receiptOrConflict(stored, digest, command.commandId)),
          );
          if (receipt !== undefined) return yield* decodeDepartmentReplay(command.commandId, receipt);
          yield* authorizeOrganizationActor(actor);
          const inserted = yield* insertDepartment(sql, command);
          const observation: DepartmentCreatedObservation = {
            _tag: "DepartmentCreated",
            commandId: command.commandId,
            department: inserted,
          };
          yield* storeReceiptAndAudit(
            sql,
            command,
            digest,
            "Department",
            inserted.departmentId,
            actor,
            observation,
          );
          const selected = yield* readDepartment(sql, inserted.departmentId);
          const department = yield* ensureCanonical(
            inserted,
            selected,
            "validate created Department projection",
          );
          return {
            committed: true as const,
            observation: { ...observation, department },
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("create Organization Department transaction", cause)),
        ),
      );
  });

export const createOrganizationTeam = (
  commandInput: CreateTeamCommand,
  actorInput: OrganizationActor,
): Effect.Effect<CreateTeamResult, OrganizationCommandFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* decodeCreateTeamCommand(commandInput);
    const actor = yield* decodeOrganizationActor(actorInput);
    const sql = yield* Database;
    const digest = organizationCommandDigest(command);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockCommand(sql, command.commandId);
          const receipt = yield* readReceipt(sql, command.commandId).pipe(
            Effect.flatMap((stored) => receiptOrConflict(stored, digest, command.commandId)),
          );
          if (receipt !== undefined) return yield* decodeTeamReplay(command.commandId, receipt);
          yield* authorizeOrganizationActor(actor);
          yield* requireDepartment(sql, command.departmentId);
          const inserted = yield* insertTeam(sql, command);
          const observation: TeamCreatedObservation = {
            _tag: "TeamCreated",
            commandId: command.commandId,
            team: inserted,
          };
          yield* storeReceiptAndAudit(
            sql,
            command,
            digest,
            "Team",
            inserted.teamId,
            actor,
            observation,
          );
          const selected = yield* readTeam(sql, inserted.teamId);
          const team = yield* ensureCanonical(
            inserted,
            selected,
            "validate created Team projection",
          );
          return {
            committed: true as const,
            observation: { ...observation, team },
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("create Organization Team transaction", cause)),
        ),
      );
  });

export const createOrganizationFieldOfStudy = (
  commandInput: CreateFieldOfStudyCommand,
  actorInput: OrganizationActor,
): Effect.Effect<CreateFieldOfStudyResult, OrganizationCommandFailure, Database> =>
  Effect.gen(function* () {
    const command = yield* decodeCreateFieldOfStudyCommand(commandInput);
    const actor = yield* decodeOrganizationActor(actorInput);
    const sql = yield* Database;
    const digest = organizationCommandDigest(command);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* lockCommand(sql, command.commandId);
          const receipt = yield* readReceipt(sql, command.commandId).pipe(
            Effect.flatMap((stored) => receiptOrConflict(stored, digest, command.commandId)),
          );
          if (receipt !== undefined)
            return yield* decodeFieldOfStudyReplay(command.commandId, receipt);
          yield* authorizeOrganizationActor(actor);
          if (command.departmentId !== null) yield* requireDepartment(sql, command.departmentId);
          const inserted = yield* insertFieldOfStudy(sql, command);
          const observation: FieldOfStudyCreatedObservation = {
            _tag: "FieldOfStudyCreated",
            commandId: command.commandId,
            fieldOfStudy: inserted,
          };
          yield* storeReceiptAndAudit(
            sql,
            command,
            digest,
            "FieldOfStudy",
            inserted.fieldOfStudyId,
            actor,
            observation,
          );
          const selected = yield* readFieldOfStudy(sql, inserted.fieldOfStudyId);
          const fieldOfStudy = yield* ensureCanonical(
            inserted,
            selected,
            "validate created FieldOfStudy projection",
          );
          return {
            committed: true as const,
            observation: { ...observation, fieldOfStudy },
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(persistenceError("create Organization FieldOfStudy transaction", cause)),
        ),
      );
  });
