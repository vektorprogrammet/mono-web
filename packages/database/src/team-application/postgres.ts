import { randomUUID } from "node:crypto";
import { DateTime, Effect, flow, Match, Option, Predicate, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import type * as Statement from "effect/unstable/sql/Statement";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import { Department, Team, TeamId } from "@vektorprogrammet/domain/organization";
import {
  decodeTeamApplicationCursor,
  evaluateTeamApplicationIntake,
  isTeamApplicationIntakeOpen,
  mapOrganizationAuthorityToTeamApplicationActor,
  PublicTeamApplicationIntake,
  TEAM_APPLICATION_INTAKE_LIST_LIMIT,
  TEAM_APPLICATION_PAGE_SIZE,
  TeamApplication,
  TeamApplicationAccessDenied,
  TeamApplicationAction,
  TeamApplicationCommandConflict,
  TeamApplicationConfirmation,
  TeamApplicationId,
  TeamApplicationIntake,
  TeamApplicationIntakeClosed,
  TeamApplicationIntakeListItem,
  TeamApplicationNotFound,
  TeamApplicationSummary,
  TeamApplicationTeamNotFound,
  teamApplicationNotifications,
  teamApplicationPage,
  type DeleteTeamApplicationCommand,
  type ReviseTeamApplicationIntakeCommand,
  type SubmitTeamApplicationCommand,
  type TeamApplicationCommandId,
  type TeamApplicationPrincipal,
} from "@vektorprogrammet/domain/team-application";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import {
  lockPersonAuthorization,
  resolveOrganizationPersonAuthorityWithSql,
} from "../organization/authority-postgres.js";
import { Database, type DatabaseOperations } from "../service.js";
import { cancelTeamApplicationOutbox, insertTeamApplicationOutbox } from "./outbox.js";
import { persistenceFailure } from "./persistence.js";

/** Every fact of the open predicate plus the names shown beside it. */
const TeamIntakeRow = Schema.Struct({
  teamId: TeamId,
  teamName: Team.fields.name,
  teamEmail: Team.fields.email,
  teamActive: Schema.Boolean,
  acceptApplication: Team.fields.acceptApplication,
  deadline: Team.fields.deadline,
  revision: Team.fields.revision,
  departmentName: Department.fields.name,
  departmentEmail: Department.fields.email,
  departmentActive: Schema.Boolean,
});

/** Single and collection intake reads share one projection, so both evaluate the same facts. */
const intakeProjection = (sql: DatabaseOperations) => sql`
  SELECT
    team.team_id AS "teamId",
    team.name AS "teamName",
    team.email AS "teamEmail",
    team.active AS "teamActive",
    team.accept_application AS "acceptApplication",
    CASE WHEN team.deadline IS NULL THEN NULL
      ELSE to_char(team.deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    END AS deadline,
    team.revision,
    department.name AS "departmentName",
    department.email AS "departmentEmail",
    department.active AS "departmentActive"
  FROM public.organization_teams AS team
  INNER JOIN public.organization_departments AS department
    ON department.department_id = team.department_id
`;

const findTeamIntake = flow(
  SqlSchema.findOneOption({
    Request: Schema.Struct({
      teamId: TeamId,
      lock: Schema.Literals(["None", "Share", "Update"]),
    }),
    Result: TeamIntakeRow,
    execute: ({ teamId, lock }) =>
      Database.use(
        (sql) => sql`
          ${intakeProjection(sql)}
          WHERE team.team_id = ${teamId}
          ${Match.value(lock).pipe(
            Match.when("Share", (): Statement.Fragment => sql`FOR SHARE OF team, department`),
            Match.when("Update", (): Statement.Fragment => sql`FOR UPDATE OF team`),
            Match.orElse((): Statement.Fragment => sql``),
          )}
        `,
      ),
  }),
  Effect.mapError(persistenceFailure("read team application intake")),
);

const findActiveTeamIntakes = flow(
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: TeamIntakeRow,
    execute: () =>
      Database.use(
        (sql) => sql`
          ${intakeProjection(sql)}
          WHERE team.active AND department.active
          ORDER BY team.team_id
          LIMIT ${TEAM_APPLICATION_INTAKE_LIST_LIMIT}
        `,
      ),
  }),
  Effect.mapError(persistenceFailure("list team application intakes")),
);

const findApplication = flow(
  SqlSchema.findOneOption({
    Request: TeamApplicationId,
    Result: Schema.Struct({ ...TeamApplication.fields, teamName: Team.fields.name }),
    execute: (applicationId) =>
      Database.use(
        (sql) => sql`
          SELECT
            application.application_id AS "applicationId",
            application.team_id AS "teamId",
            application.name,
            application.email,
            application.phone,
            application.year_of_study AS "yearOfStudy",
            application.field_of_study AS "fieldOfStudy",
            application.biography,
            application.motivation,
            to_char(application.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              AS "submittedAt",
            team.name AS "teamName"
          FROM public.team_applications AS application
          INNER JOIN public.organization_teams AS team ON team.team_id = application.team_id
          WHERE application.application_id = ${applicationId}
        `,
      ),
  }),
  Effect.mapError(persistenceFailure("read team application")),
);

const findApplicationTeam = flow(
  SqlSchema.findOneOption({
    Request: Schema.Struct({ applicationId: TeamApplicationId, lock: Schema.Boolean }),
    Result: Schema.Struct({ teamId: TeamId }),
    execute: ({ applicationId, lock }) =>
      Database.use(
        (sql) => sql`
          SELECT team_id AS "teamId"
          FROM public.team_applications
          WHERE application_id = ${applicationId}
          ${lock ? sql`FOR UPDATE` : sql``}
        `,
      ),
  }),
  Effect.mapError(persistenceFailure("read team application team")),
);

/** The submission receipt keeps the team of a deleted application for replay authority. */
const findSubmittedApplicationTeam = flow(
  SqlSchema.findOneOption({
    Request: TeamApplicationId,
    Result: Schema.Struct({ teamId: TeamId }),
    execute: (applicationId) =>
      Database.use(
        (sql) => sql`
          SELECT team_id AS "teamId"
          FROM public.team_application_command_receipts
          WHERE application_id = ${applicationId}
            AND operation = 'SubmitTeamApplication'
        `,
      ),
  }),
  Effect.mapError(persistenceFailure("read submitted team application team")),
);

const findApplicationPage = flow(
  SqlSchema.findAll({
    Request: Schema.Struct({
      teamId: TeamId,
      afterTimestamp: Schema.NullOr(Schema.String),
      afterApplicationId: Schema.NullOr(TeamApplicationId),
    }),
    Result: Schema.Struct({ ...TeamApplicationSummary.fields, cursorTimestamp: Schema.String }),
    execute: ({ teamId, afterTimestamp, afterApplicationId }) =>
      Database.use(
        (sql) => sql`
          SELECT
            application_id AS "applicationId",
            name,
            to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "submittedAt",
            to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTimestamp"
          FROM public.team_applications
          WHERE team_id = ${teamId}
            AND (
              ${afterTimestamp}::timestamptz IS NULL
              OR (submitted_at, application_id) < (${afterTimestamp}::timestamptz, ${afterApplicationId}::text)
            )
          ORDER BY submitted_at DESC, application_id DESC
          LIMIT ${TEAM_APPLICATION_PAGE_SIZE + 1}
        `,
      ),
  }),
  Effect.mapError(persistenceFailure("list team applications")),
);

const insertApplication = flow(
  SqlSchema.void({
    Request: TeamApplication,
    execute: (application) =>
      Database.use(
        (sql) => sql`
          INSERT INTO public.team_applications (
            application_id, team_id, name, email, phone, year_of_study, field_of_study,
            biography, motivation, submitted_at
          ) VALUES (
            ${application.applicationId}, ${application.teamId}, ${application.name},
            ${application.email}, ${application.phone}, ${application.yearOfStudy},
            ${application.fieldOfStudy}, ${application.biography}, ${application.motivation},
            ${application.submittedAt}
          )
        `,
      ),
  }),
  Effect.mapError(persistenceFailure("insert team application")),
);

const CommandOperation = Schema.Literals([
  "SubmitTeamApplication",
  "DeleteTeamApplication",
  "ReviseTeamApplicationIntake",
]);

type CommandOperation = typeof CommandOperation.Type;

const findCommandReceipt = flow(
  SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      commandSha256: Schema.String,
      operation: CommandOperation,
      observation: Schema.Unknown,
    }),
    execute: (commandId) =>
      Database.use(
        (sql) => sql`
          SELECT command_sha256 AS "commandSha256", operation, observation_json AS observation
          FROM public.team_application_command_receipts
          WHERE command_id = ${commandId}
        `,
      ),
  }),
  Effect.mapError(persistenceFailure("read team application command receipt")),
);

/**
 * Serializes one command identifier and returns its committed observation when the
 * same request already committed. A different request under the identifier conflicts.
 */
const committedObservation = <S extends Schema.ConstraintDecoder<unknown, never>>(
  commandId: TeamApplicationCommandId,
  operation: CommandOperation,
  digest: string,
  observation: S,
) =>
  Effect.gen(function* () {
    yield* Database.use((sql) =>
      lockAdvisory(sql, AdvisoryLockKey.teamApplicationCommand(commandId)),
    ).pipe(Effect.mapError(persistenceFailure("lock team application command")));

    const stored = yield* findCommandReceipt(commandId);

    if (Option.isNone(stored)) return Option.none<S["Type"]>();

    if (stored.value.operation !== operation || stored.value.commandSha256 !== digest) {
      return yield* new TeamApplicationCommandConflict({ commandId });
    }

    return Option.some(
      yield* Schema.decodeUnknownEffect(observation)(stored.value.observation, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(persistenceFailure("decode team application command receipt"))),
    );
  });

const recordCommand = (input: {
  readonly commandId: TeamApplicationCommandId;
  readonly operation: CommandOperation;
  readonly digest: string;
  readonly teamId: TeamId;
  readonly applicationId: TeamApplicationId | null;
  readonly observation: Schema.Json;
  readonly committedAt: string;
}) =>
  Database.use(
    (sql) => sql`
      INSERT INTO public.team_application_command_receipts (
        command_id, command_sha256, operation, team_id, application_id, observation_json,
        committed_at
      ) VALUES (
        ${input.commandId}, ${input.digest}, ${input.operation}, ${input.teamId},
        ${input.applicationId}, ${sql.json(input.observation)}, ${input.committedAt}
      )
    `,
  ).pipe(Effect.asVoid, Effect.mapError(persistenceFailure("insert team application command")));

const recordAudit = (input: {
  readonly commandId: TeamApplicationCommandId;
  readonly action: "TeamApplicationDeleted" | "TeamApplicationIntakeRevised";
  readonly actorPersonId: string;
  readonly teamId: TeamId;
  readonly applicationId: TeamApplicationId | null;
  readonly before: typeof TeamIntakeRow.Type | null;
  readonly after: TeamApplicationIntake | null;
  readonly occurredAt: string;
}) =>
  Database.use(
    (sql) => sql`
      INSERT INTO public.team_application_audit (
        command_id, action, actor_person_id, team_id, application_id,
        accept_application_before, deadline_before, accept_application_after, deadline_after,
        team_revision_before, team_revision_after, occurred_at
      ) VALUES (
        ${input.commandId}, ${input.action}, ${input.actorPersonId}, ${input.teamId},
        ${input.applicationId}, ${input.before?.acceptApplication ?? null},
        ${input.before?.deadline ?? null}, ${input.after?.acceptApplication ?? null},
        ${input.after?.deadline ?? null}, ${input.before?.revision ?? null},
        ${input.after?.revision ?? null}, ${input.occurredAt}
      )
    `,
  ).pipe(Effect.asVoid, Effect.mapError(persistenceFailure("insert team application audit")));

const commandDigest = (request: Schema.Json): string => sha256Hex(canonicalJsonBytes(request));

const staffIntake = (
  team: typeof TeamIntakeRow.Type,
  now: DateTime.Utc,
): TeamApplicationIntake => ({
  acceptApplication: team.acceptApplication === true,
  deadline: team.deadline,
  revision: team.revision,
  open: isTeamApplicationIntakeOpen(team, now),
});

/**
 * Resolves current Organization authority for one team. A change requires the
 * leader and takes the person lock after the caller's target row lock.
 */
const resolveTeamActor = (principal: TeamApplicationPrincipal, teamId: TeamId, changes: boolean) =>
  Effect.gen(function* () {
    const sql = yield* Database;

    if (changes) {
      yield* lockPersonAuthorization(sql, principal.personId).pipe(
        Effect.mapError(persistenceFailure("lock team application authority")),
      );
    }

    const authority = yield* resolveOrganizationPersonAuthorityWithSql(
      sql,
      principal.personId,
      principal.authorizationInstant,
      changes ? "ForShare" : "None",
    ).pipe(Effect.mapError(persistenceFailure("resolve team application authority")));

    const decision = mapOrganizationAuthorityToTeamApplicationActor(authority, teamId);

    if (Predicate.isTagged(decision, "Deny")) {
      return yield* new TeamApplicationAccessDenied({
        reason: decision.reason === "AuthorityInactive" ? "AuthorityInactive" : "NotInScope",
      });
    }

    if (changes && !Predicate.isTagged(decision.value, "TeamLeader")) {
      return yield* new TeamApplicationAccessDenied({ reason: "NotLeader" });
    }

    return decision.value;
  });

const authorizeIntakeRevision = (principal: TeamApplicationPrincipal, teamId: TeamId) =>
  findTeamIntake({ teamId, lock: "Update" }).pipe(
    Effect.andThen(resolveTeamActor(principal, teamId, true)),
  );

/** A deleted application keeps its submission team, so a replayed deletion is authorized against it. */
const applicationTeam = (applicationId: TeamApplicationId, forDeletion: boolean) =>
  findApplicationTeam({ applicationId, lock: forDeletion }).pipe(
    Effect.flatMap((current) =>
      Option.isSome(current) || !forDeletion
        ? Effect.succeed(current)
        : findSubmittedApplicationTeam(applicationId),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new TeamApplicationNotFound({ applicationId })),
        onSome: (row) => Effect.succeed(row.teamId),
      }),
    ),
  );

export const authorizeTeamApplicationAction = (
  principal: TeamApplicationPrincipal,
  action: TeamApplicationAction,
) =>
  TeamApplicationAction.$match(action, {
    ReadTeamApplications: ({ teamId }) => resolveTeamActor(principal, teamId, false),
    ReviseTeamApplicationIntake: ({ teamId }) => authorizeIntakeRevision(principal, teamId),
    ReadTeamApplication: ({ applicationId }) =>
      applicationTeam(applicationId, false).pipe(
        Effect.flatMap((teamId) => resolveTeamActor(principal, teamId, false)),
      ),
    DeleteTeamApplication: ({ applicationId }) =>
      applicationTeam(applicationId, true).pipe(
        Effect.flatMap((teamId) => resolveTeamActor(principal, teamId, true)),
      ),
  });

export const readPublicTeamApplicationIntake = (teamId: TeamId) =>
  Effect.gen(function* () {
    const team = yield* findTeamIntake({ teamId, lock: "None" });

    if (Option.isNone(team) || !team.value.teamActive || !team.value.departmentActive) {
      return yield* new TeamApplicationTeamNotFound({ teamId });
    }

    const now = yield* DateTime.now;

    return PublicTeamApplicationIntake.make({
      teamId: team.value.teamId,
      teamName: team.value.teamName,
      departmentName: team.value.departmentName,
      open: isTeamApplicationIntakeOpen(team.value, now),
      deadline: team.value.deadline,
    });
  });

export const listPublicTeamApplicationIntakes = Effect.gen(function* () {
  const rows = yield* findActiveTeamIntakes();
  const now = yield* DateTime.now;

  return rows.map((row) =>
    TeamApplicationIntakeListItem.make({
      teamId: row.teamId,
      open: isTeamApplicationIntakeOpen(row, now),
      deadline: row.deadline,
    }),
  );
});

export const submitTeamApplication = (command: SubmitTeamApplicationCommand) =>
  Effect.gen(function* () {
    const digest = commandDigest({
      schema: "SubmitTeamApplication/v1",
      teamId: command.teamId,
      application: command.application,
    });

    const replayed = yield* committedObservation(
      command.commandId,
      "SubmitTeamApplication",
      digest,
      TeamApplicationConfirmation,
    );

    if (Option.isSome(replayed)) return { confirmation: replayed.value, replayed: true };

    const team = yield* findTeamIntake({ teamId: command.teamId, lock: "Share" });

    if (Option.isNone(team) || !team.value.teamActive || !team.value.departmentActive) {
      return yield* new TeamApplicationTeamNotFound({ teamId: command.teamId });
    }

    const now = yield* DateTime.now;
    const intake = evaluateTeamApplicationIntake(team.value, now);

    if (!Predicate.isTagged(intake, "Open")) {
      return yield* new TeamApplicationIntakeClosed({ teamId: command.teamId });
    }

    const submittedAt = DateTime.formatIso(now);

    const application = TeamApplication.make({
      applicationId: TeamApplicationId.make(randomUUID()),
      teamId: command.teamId,
      ...command.application,
      submittedAt,
    });

    yield* insertApplication(application);

    const confirmation = TeamApplicationConfirmation.make({
      applicationId: application.applicationId,
      teamId: application.teamId,
      submittedAt,
    });

    yield* recordCommand({
      commandId: command.commandId,
      operation: "SubmitTeamApplication",
      digest,
      teamId: application.teamId,
      applicationId: application.applicationId,
      observation: confirmation,
      committedAt: submittedAt,
    });

    yield* Effect.forEach(
      teamApplicationNotifications(
        command.commandId,
        application,
        team.value.teamName,
        intake.mailbox,
      ),
      (notification, ordinal) => insertTeamApplicationOutbox(notification, ordinal, submittedAt),
      { discard: true },
    );

    return { confirmation, replayed: false };
  });

export const listTeamApplications = (
  principal: TeamApplicationPrincipal,
  teamId: TeamId,
  cursor?: string,
) =>
  Effect.gen(function* () {
    const actor = yield* resolveTeamActor(principal, teamId, false);

    const position = cursor === undefined ? undefined : yield* decodeTeamApplicationCursor(cursor);
    const team = yield* findTeamIntake({ teamId, lock: "None" });

    if (Option.isNone(team))
      return yield* new TeamApplicationAccessDenied({ reason: "NotInScope" });

    const now = yield* DateTime.now;

    const rows = yield* findApplicationPage({
      teamId,
      afterTimestamp: position?.timestamp ?? null,
      afterApplicationId: position?.applicationId ?? null,
    });

    const page = teamApplicationPage(rows, (row) => ({
      timestamp: row.cursorTimestamp,
      applicationId: row.applicationId,
    }));

    return {
      ...page,
      items: page.items.map(({ cursorTimestamp: _cursorTimestamp, ...item }) => item),
      teamId,
      teamName: team.value.teamName,
      intake: staffIntake(team.value, now),
      actor,
    };
  });

export const readTeamApplication = (
  principal: TeamApplicationPrincipal,
  applicationId: TeamApplicationId,
) =>
  Effect.gen(function* () {
    const actor = yield* authorizeTeamApplicationAction(
      principal,
      TeamApplicationAction.ReadTeamApplication({ applicationId }),
    );

    const row = yield* findApplication(applicationId);

    if (Option.isNone(row)) return yield* new TeamApplicationNotFound({ applicationId });

    const { teamName, ...application } = row.value;

    return { application, teamName, actor };
  });

export const deleteTeamApplication = (
  command: DeleteTeamApplicationCommand,
  principal: TeamApplicationPrincipal,
) =>
  Effect.gen(function* () {
    const actor = yield* authorizeTeamApplicationAction(
      principal,
      TeamApplicationAction.DeleteTeamApplication({ applicationId: command.applicationId }),
    );

    const digest = commandDigest({
      schema: "DeleteTeamApplication/v1",
      applicationId: command.applicationId,
      personId: principal.personId,
    });

    const replayed = yield* committedObservation(
      command.commandId,
      "DeleteTeamApplication",
      digest,
      Schema.Struct({ applicationId: TeamApplicationId }),
    );

    if (Option.isSome(replayed)) return;

    const deleted = yield* Database.use(
      (sql) => sql<{ readonly applicationId: string }>`
        DELETE FROM public.team_applications
        WHERE application_id = ${command.applicationId}
        RETURNING application_id AS "applicationId"
      `,
    ).pipe(Effect.mapError(persistenceFailure("delete team application")));

    if (deleted.length !== 1) {
      return yield* new TeamApplicationNotFound({ applicationId: command.applicationId });
    }

    yield* cancelTeamApplicationOutbox(command.applicationId);

    const occurredAt = DateTime.formatIso(yield* DateTime.now);

    yield* recordCommand({
      commandId: command.commandId,
      operation: "DeleteTeamApplication",
      digest,
      teamId: actor.teamId,
      applicationId: command.applicationId,
      observation: { applicationId: command.applicationId },
      committedAt: occurredAt,
    });

    yield* recordAudit({
      commandId: command.commandId,
      action: "TeamApplicationDeleted",
      actorPersonId: actor.personId,
      teamId: actor.teamId,
      applicationId: command.applicationId,
      before: null,
      after: null,
      occurredAt,
    });
  });

export const reviseTeamApplicationIntake = <E, R>(
  command: ReviseTeamApplicationIntakeCommand,
  principal: TeamApplicationPrincipal,
  checkPrecondition: (current: TeamApplicationIntake) => Effect.Effect<void, E, R>,
) =>
  Effect.gen(function* () {
    const actor = yield* authorizeIntakeRevision(principal, command.teamId);

    const digest = commandDigest({
      schema: "ReviseTeamApplicationIntake/v1",
      personId: principal.personId,
      teamId: command.teamId,
      acceptApplication: command.acceptApplication ?? "unchanged",
      deadline: command.deadline === undefined ? "unchanged" : command.deadline,
    });

    const replayed = yield* committedObservation(
      command.commandId,
      "ReviseTeamApplicationIntake",
      digest,
      TeamApplicationIntake,
    );

    if (Option.isSome(replayed)) {
      return { teamId: command.teamId, intake: replayed.value, replayed: true };
    }

    const team = yield* findTeamIntake({ teamId: command.teamId, lock: "Update" });

    if (Option.isNone(team))
      return yield* new TeamApplicationAccessDenied({ reason: "NotInScope" });

    const now = yield* DateTime.now;

    yield* checkPrecondition(staffIntake(team.value, now));

    const acceptApplication = command.acceptApplication ?? team.value.acceptApplication === true;
    const deadline = command.deadline === undefined ? team.value.deadline : command.deadline;

    const updated = yield* Database.use(
      (sql) => sql<{ readonly deadline: string | null; readonly revision: number }>`
        UPDATE public.organization_teams SET
          accept_application = ${acceptApplication},
          deadline = ${deadline}::timestamptz,
          revision = revision + 1
        WHERE team_id = ${command.teamId}
          AND revision = ${team.value.revision}
        RETURNING
          CASE WHEN deadline IS NULL THEN NULL
            ELSE to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          END AS deadline,
          revision
      `,
    ).pipe(Effect.mapError(persistenceFailure("revise team application intake")));

    const revised = updated[0];

    if (revised === undefined) {
      return yield* persistenceFailure("revise team application intake")(
        "team revision changed while locked",
      );
    }

    const intake = TeamApplicationIntake.make({
      acceptApplication,
      deadline: revised.deadline,
      revision: revised.revision,
      open: isTeamApplicationIntakeOpen(
        { ...team.value, acceptApplication, deadline: revised.deadline },
        now,
      ),
    });

    const occurredAt = DateTime.formatIso(now);

    yield* recordCommand({
      commandId: command.commandId,
      operation: "ReviseTeamApplicationIntake",
      digest,
      teamId: command.teamId,
      applicationId: null,
      observation: intake,
      committedAt: occurredAt,
    });

    yield* recordAudit({
      commandId: command.commandId,
      action: "TeamApplicationIntakeRevised",
      actorPersonId: actor.personId,
      teamId: command.teamId,
      applicationId: null,
      before: team.value,
      after: intake,
      occurredAt,
    });

    return { teamId: command.teamId, intake, replayed: false };
  });
