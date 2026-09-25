import { DateTime, Effect, Predicate, Schema } from "effect";
import { SqlSchema } from "effect/unstable/sql";
import { canonicalJsonBytes, sha256Hex } from "@vektorprogrammet/domain/evidence";
import {
  DepartmentId,
  PersonId,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import {
  InterviewSchemaId,
  ManagedQuestionnaire,
  QuestionnaireHistory,
  QuestionnaireManagement,
  InterviewStaffing,
  InterviewStaffingHistory,
  InterviewStaffingManagement,
  RecruitmentMaintenanceCommand,
  RecruitmentMaintenanceResult,
  RecruitmentMaintenanceFailure,
  RecruitmentPersistenceError,
} from "@vektorprogrammet/domain/recruitment";
import { AdvisoryLockKey, lockAdvisory } from "../advisory-lock.js";
import { Database, type DatabaseOperations } from "../service.js";
import {
  lockPersonAuthorization,
  resolveOrganizationPersonAuthorityWithSql,
} from "../organization/authority-postgres.js";
import { guardInterviewApplicantIdentity } from "./conduct-identity.js";
import { sealInterviewInvitationEnvelopes } from "./outbox.js";
import { sealInterviewResponseEnvelopes } from "./response-outbox.js";

const fail = (code: RecruitmentMaintenanceFailure["code"]) =>
  new RecruitmentMaintenanceFailure({ code });

const persistence = (cause: unknown) =>
  new RecruitmentPersistenceError({
    operation: "recruitment maintenance",
    message: String(cause),
    cause,
  });

const mapFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchTags({
      SqlError: persistence,
      SchemaError: persistence,
      OrganizationPersistenceError: persistence,
      OrganizationDecodeError: persistence,
    }),
  );

const decodeCommand = Schema.decodeUnknownEffect(RecruitmentMaintenanceCommand, {
  onExcessProperty: "error",
});

const departmentsFor = (authority: OrganizationPersonAuthority) => [
  ...new Set(
    authority.memberships
      .filter((entry) => entry.active && entry.teamLeader)
      .map((entry) => entry.departmentId),
  ),
];

const authorityFor = Effect.fn("Recruitment.maintenanceAuthority")(function* (
  sql: DatabaseOperations,
  personId: PersonId,
  now: string,
  lock: boolean,
) {
  const rows = yield* sql<{
    enabled: boolean;
  }>`SELECT NOT access_disabled AS enabled FROM auth."user" WHERE id=${personId} ${lock ? sql`FOR SHARE` : sql``}`;

  if (!rows[0]?.enabled) return yield* fail("Denied");

  return yield* resolveOrganizationPersonAuthorityWithSql(
    sql,
    personId,
    now,
    lock ? "ForShare" : "None",
  );
});

const questionnaireRows = (sql: DatabaseOperations, id: InterviewSchemaId | null, lock: boolean) =>
  SqlSchema.findAll({
    Request: Schema.NullOr(InterviewSchemaId),
    Result: ManagedQuestionnaire,
    execute: (
      id,
    ) => sql`SELECT s.interview_schema_id AS "interviewSchemaId",s.name,s.active,s.revision,
      (SELECT count(*)::integer FROM public.recruitment_interview_schema_questions q WHERE q.interview_schema_id=s.interview_schema_id) AS "questionCount",
      CASE WHEN s.question_count > 0 AND s.question_count=(SELECT count(*) FROM public.recruitment_interview_schema_questions q WHERE q.interview_schema_id=s.interview_schema_id) THEN 'Available' ELSE 'Unavailable' END AS "sourceState",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('questionId',q.question_id,'ordinal',q.ordinal,'prompt',q.prompt,'helpText',q.help_text,'kind',q.kind,'alternatives',q.alternatives) ORDER BY q.ordinal) FROM public.recruitment_interview_schema_questions q WHERE q.interview_schema_id=s.interview_schema_id),'[]'::jsonb) AS questions
      FROM public.recruitment_interview_schemas s WHERE ${id === null ? sql`TRUE` : sql`s.interview_schema_id=${id}`} ORDER BY s.name,s.interview_schema_id ${lock ? sql`FOR UPDATE OF s` : sql``}`,
  })(id);

const staffingRows = (
  sql: DatabaseOperations,
  scope: ReadonlyArray<DepartmentId> | null,
  id: string | null,
  lock: boolean,
) =>
  SqlSchema.findAll({
    Request: Schema.Void,
    Result: InterviewStaffing,
    execute:
      () => sql`SELECT i.interview_id AS "interviewId",i.department_id AS "departmentId",p.first_name || ' ' || p.last_name AS "applicantName",
      i.interviewer_person_id AS "interviewerPersonId",i.co_interviewer_person_id AS "coInterviewerPersonId",i.revision,
      (EXISTS(SELECT 1 FROM public.recruitment_interview_conducts c WHERE c.interview_id=i.interview_id) OR EXISTS(SELECT 1 FROM public.recruitment_interview_cancellations c WHERE c.interview_id=i.interview_id)) AS terminal
      FROM public.recruitment_interviews i JOIN public.admission_applications a USING(application_id) JOIN public.admission_applicants p USING(applicant_id)
      WHERE ${scope === null ? sql`TRUE` : sql.in("i.department_id", scope)} AND ${id === null ? sql`TRUE` : sql`i.interview_id=${id}`}
      ORDER BY i.assigned_at DESC,i.interview_id ${lock ? sql`FOR UPDATE OF i` : sql``}`,
  })(undefined);

export const readQuestionnaires = (personId: PersonId) =>
  Effect.gen(function* () {
    const sql = yield* Database;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

        const authority = yield* authorityFor(
          sql,
          personId,
          DateTime.formatIso(yield* DateTime.now),
          false,
        );

        if (authority.globalAdministrator !== "Active") return yield* fail("Denied");
        const questionnaires = yield* questionnaireRows(sql, null, false);

        const history = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: QuestionnaireHistory,
          execute:
            () => sql`SELECT command_id AS "commandId",actor_person_id AS "actorPersonId",interview_schema_id AS "interviewSchemaId",reason,revision,
      to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",before_json AS before,after_json AS after FROM public.recruitment_questionnaire_history ORDER BY recorded_at DESC,interview_schema_id,revision DESC`,
        })(undefined);

        return yield* Schema.decodeUnknownEffect(QuestionnaireManagement)({
          questionnaires,
          history,
        });
      }),
    );
  }).pipe(mapFailure);

export const readInterviewStaffing = (personId: PersonId) =>
  Effect.gen(function* () {
    const sql = yield* Database;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
        const now = DateTime.formatIso(yield* DateTime.now);
        const authority = yield* authorityFor(sql, personId, now, false);
        const scope = authority.globalAdministrator === "Active" ? null : departmentsFor(authority);

        if (scope !== null && scope.length === 0) return yield* fail("Denied");
        const interviews = yield* staffingRows(sql, scope, null, false);

        const candidates = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: InterviewStaffingManagement.fields.candidates.value,
          execute:
            () => sql`SELECT DISTINCT p.person_id AS "personId",p.first_name || ' ' || p.last_name AS "displayName",d.department_id AS "departmentId"
      FROM public.organization_memberships m JOIN public.organization_teams t USING(team_id) JOIN public.organization_departments d USING(department_id)
      JOIN public.person_profiles p USING(person_id) JOIN auth."user" u ON u.id=p.person_id
      WHERE ${scope === null ? sql`TRUE` : sql.in("d.department_id", scope)} AND t.active AND d.active AND NOT m.is_suspended AND NOT u.access_disabled
        AND m.start_at <= ${now}::timestamptz AND (m.end_at IS NULL OR ${now}::timestamptz < m.end_at)
      ORDER BY "displayName","personId","departmentId"`,
        })(undefined);

        const history = yield* SqlSchema.findAll({
          Request: Schema.Void,
          Result: InterviewStaffingHistory,
          execute:
            () => sql`SELECT command_id AS "commandId",actor_person_id AS "actorPersonId",interview_id AS "interviewId",reason,revision,
      to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",before_json AS before,after_json AS after
      FROM public.recruitment_staffing_history WHERE ${scope === null ? sql`TRUE` : sql.in("department_id", scope)} ORDER BY recorded_at DESC,interview_id,revision DESC`,
        })(undefined);

        return yield* Schema.decodeUnknownEffect(InterviewStaffingManagement)({
          interviews,
          candidates,
          history,
        });
      }),
    );
  }).pipe(mapFailure);

const authorizeWithSql = Effect.fn("Recruitment.authorizeMaintenance")(function* (
  sql: DatabaseOperations,
  command: RecruitmentMaintenanceCommand,
  personId: PersonId,
) {
  const staffing = Predicate.isTagged(command, "ChangeInterviewStaffing");

  const people = staffing
    ? [
        personId,
        command.interviewerPersonId,
        ...(command.coInterviewerPersonId === null ? [] : [command.coInterviewerPersonId]),
      ]
    : [personId];

  for (const id of [...new Set(people)].sort()) yield* lockPersonAuthorization(sql, id);

  const identity = staffing
    ? yield* guardInterviewApplicantIdentity(command.interviewId, personId)
    : null;

  const now = DateTime.formatIso(yield* DateTime.now);
  const authority = yield* authorityFor(sql, personId, now, true);

  if (!staffing) {
    if (authority.globalAdministrator !== "Active") return yield* fail("Denied");

    return;
  }

  if (
    authority.globalAdministrator !== "Active" &&
    !departmentsFor(authority).includes(identity!.departmentId)
  )
    return yield* fail("Denied");
  yield* lockAdvisory(sql, AdvisoryLockKey.recruitmentInterview(command.interviewId));
});

export const authorizeMaintenance = (command: RecruitmentMaintenanceCommand, personId: PersonId) =>
  Effect.gen(function* () {
    const sql = yield* Database;
    const decoded = yield* decodeCommand(command).pipe(Effect.mapError(() => fail("Invalid")));
    yield* authorizeWithSql(sql, decoded, personId);
  }).pipe(mapFailure);

export const maintainRecruitment = (input: RecruitmentMaintenanceCommand, personId: PersonId) =>
  Effect.gen(function* () {
    const command = yield* decodeCommand(input).pipe(Effect.mapError(() => fail("Invalid")));
    const sql = yield* Database;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* authorizeWithSql(sql, command, personId);
        yield* lockAdvisory(
          sql,
          AdvisoryLockKey.recruitmentMaintenanceCommand(personId, command.commandId),
        );
        const digest = sha256Hex(canonicalJsonBytes(command));

        const receipts = yield* sql<{
          digest: string;
          result: unknown;
        }>`SELECT command_digest AS digest,result_json AS result FROM public.recruitment_maintenance_command_receipts WHERE actor_person_id=${personId} AND command_id=${command.commandId}`;

        if (receipts[0]) {
          if (receipts[0].digest !== digest) return yield* fail("Conflict");

          return yield* Schema.decodeUnknownEffect(RecruitmentMaintenanceResult)(
            receipts[0].result,
          );
        }

        if (Predicate.isTagged(command, "ChangeInterviewStaffing")) {
          // Workers lock their outbox before taking interview row locks.
          yield* sealInterviewInvitationEnvelopes(command.interviewId);
          yield* sealInterviewResponseEnvelopes(command.interviewId);
          const before = (yield* staffingRows(sql, null, command.interviewId, true))[0];

          if (!before) return yield* fail("NotFound");

          if (before.terminal) return yield* fail("Terminal");

          if (command.coInterviewerPersonId === command.interviewerPersonId)
            return yield* fail("Ineligible");
          const identity = yield* guardInterviewApplicantIdentity(command.interviewId, personId);
          const now = DateTime.formatIso(yield* DateTime.now);

          const candidates =
            command.coInterviewerPersonId === null
              ? [command.interviewerPersonId]
              : [command.interviewerPersonId, command.coInterviewerPersonId];

          for (const id of candidates.toSorted()) {
            if (id === identity.linkedApplicantPersonId) return yield* fail("Ineligible");

            const eligible = yield* authorityFor(sql, id, now, true).pipe(
              Effect.catchTag("RecruitmentMaintenanceFailure", () => fail("Ineligible")),
            );

            if (
              !eligible.memberships.some(
                (entry) => entry.departmentId === before.departmentId && entry.active,
              )
            )
              return yield* fail("Ineligible");

            const profile =
              yield* sql`SELECT person_id FROM public.person_profiles WHERE person_id=${id} FOR SHARE`;

            if (profile.length !== 1) return yield* fail("Ineligible");
          }

          if (before.revision !== command.expectedRevision) return yield* fail("Stale");

          const after = {
            ...before,
            interviewerPersonId: command.interviewerPersonId,
            coInterviewerPersonId: command.coInterviewerPersonId,
            revision: before.revision + 1,
          };

          yield* sql`UPDATE public.recruitment_interviews SET interviewer_person_id=${after.interviewerPersonId},co_interviewer_person_id=${after.coInterviewerPersonId},revision=${after.revision} WHERE interview_id=${command.interviewId}`;

          const result = RecruitmentMaintenanceResult.cases.InterviewStaffingChanged.make({
            interviewId: command.interviewId,
            revision: after.revision,
          });

          yield* sql`INSERT INTO public.recruitment_maintenance_command_receipts(actor_person_id,command_id,command_digest,result_json) VALUES(${personId},${command.commandId},${digest},${sql.json(result)})`;
          yield* sql`INSERT INTO public.recruitment_staffing_history(actor_person_id,command_id,interview_id,department_id,reason,revision,before_json,after_json) VALUES(${personId},${command.commandId},${command.interviewId},${before.departmentId},${command.reason},${after.revision},${sql.json(before)},${sql.json(after)})`;

          return result;
        }

        if (command.active && command.questions.length === 0)
          return yield* fail("EmptyActiveQuestionnaire");

        const id = Predicate.isTagged(command, "CreateQuestionnaire")
          ? InterviewSchemaId.make(
              "questionnaire:" + sha256Hex(canonicalJsonBytes([personId, command.commandId])),
            )
          : command.interviewSchemaId;

        const before = Predicate.isTagged(command, "CreateQuestionnaire")
          ? null
          : (yield* questionnaireRows(sql, id, true))[0];

        if (before === undefined) return yield* fail("NotFound");

        if (
          Predicate.isTagged(command, "ReviseQuestionnaire") &&
          before!.revision !== command.expectedRevision
        )
          return yield* fail("Stale");

        const after = ManagedQuestionnaire.make({
          interviewSchemaId: id,
          name: command.name,
          active: command.active,
          questions: command.questions,
          questionCount: command.questions.length,
          revision: before === null ? 0 : before.revision + 1,
          sourceState: command.questions.length === 0 ? "Unavailable" : "Available",
        });

        if (before === null) {
          yield* sql`INSERT INTO public.recruitment_interview_schemas(interview_schema_id,name,question_count,active,revision) VALUES(${id},${after.name},${after.questionCount},${after.active},${after.revision})`;
        } else {
          yield* sql`UPDATE public.recruitment_interview_schemas SET name=${after.name},question_count=${after.questionCount},active=${after.active},revision=${after.revision} WHERE interview_schema_id=${id}`;
          yield* sql`DELETE FROM public.recruitment_interview_schema_questions WHERE interview_schema_id=${id}`;
        }

        for (const question of command.questions)
          yield* sql`INSERT INTO public.recruitment_interview_schema_questions(interview_schema_id,question_id,ordinal,prompt,help_text,kind,alternatives) VALUES(${id},${question.questionId},${question.ordinal},${question.prompt},${question.helpText},${question.kind},${sql.json(question.alternatives)})`;

        const result = RecruitmentMaintenanceResult.cases.QuestionnaireSaved.make({
          interviewSchemaId: id,
          revision: after.revision,
        });

        yield* sql`INSERT INTO public.recruitment_maintenance_command_receipts(actor_person_id,command_id,command_digest,result_json) VALUES(${personId},${command.commandId},${digest},${sql.json(result)})`;
        yield* sql`INSERT INTO public.recruitment_questionnaire_history(actor_person_id,command_id,interview_schema_id,reason,revision,before_json,after_json) VALUES(${personId},${command.commandId},${id},${command.reason},${after.revision},${before === null ? null : sql.json(before)},${sql.json(after)})`;

        return result;
      }),
    );
  }).pipe(mapFailure);
