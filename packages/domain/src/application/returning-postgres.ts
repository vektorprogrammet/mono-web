import { Effect, Schema } from "effect";
import { Database, type DatabaseShape } from "../database/service.js";
import { sha256Hex } from "../tutor/evidence.js";
import { canonicalJson, publicApplicationCommandDigest } from "./digest.js";
import { makePublicApplicationOutboxRequests } from "./effects.js";
import {
  ApplicantRecord,
  PublicApplication,
  PublicApplicationCommandIdSchema,
  PublicApplicationIdSchema,
} from "./schema.js";
import {
  ReturningAssistantIdentityAmbiguous,
  ReturningAssistantIdentityMissing,
  ReturningAssistantHistoryMissing,
  ReturningAssistantPeriodUnavailable,
  ReturningAssistantRevisionConflict,
  ReturningAssistantStudyMappingInvalid,
  ReturningAssistantTeamScopeDenied,
  ReturningAssistantCommandConflict,
  ReturningAssistantDecodeError,
  ReturningAssistantPersistenceError,
  ReturningAssistantRegistrationInputSchema,
  ReturningAssistantObservationSchema,
  ReturningRegistrationIdSchema,
  type ReturningAssistantError,
  type ReturningAssistantObservation,
  type ReturningAssistantOptions,
  type ReturningAssistantRegistrationInput,
} from "./returning.js";
import { AdmissionPeriodId, AdmissionPeriodProjectionSchema, AdmissionFieldOfStudyId } from "../admission-period/schema.js";
import { ApplicantIdSchema } from "./schema.js";
import { DepartmentId, PersonId, SemesterId, TeamId } from "../organization/schema.js";

type RegistrationContext = { readonly personId: PersonId; readonly now: string };
type LinkedIdentity = {
  readonly applicant: typeof ApplicantRecord.Type;
  readonly departmentId: string;
  readonly fieldOfStudyId: string;
  readonly placementId: string;
  readonly periods: ReadonlyArray<ReturningPeriodRow>;
  readonly teams: ReadonlyArray<{ readonly teamId: string; readonly name: string }>;
};
type ReturningPeriodRow = {
  readonly id: string;
  readonly departmentId: string;
  readonly semesterId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly revision: number;
  readonly lastCommandId: string;
  readonly semesterName: string;
};
type ReceiptRow = { readonly command_sha256: string; readonly observation_json: unknown };
type ApplicationRow = {
  readonly id: string;
  readonly applicantId: string;
  readonly admissionPeriodId: string;
  readonly departmentId: string;
  readonly fieldOfStudyId: string;
  readonly yearOfStudy: number;
  readonly submittedAt: string;
  readonly revision: number;
};
const fail = (operation: string) => new ReturningAssistantPersistenceError({ operation });
const decodeInput = (input: unknown) =>
  Schema.decodeUnknownEffect(ReturningAssistantRegistrationInputSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new ReturningAssistantDecodeError({ message: "invalid returning registration" })));
const decodeObservation = (value: unknown) =>
  Schema.decodeUnknownEffect(ReturningAssistantObservationSchema)(value, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => fail("decode returning receipt")));
const rowApplicant = (row: Record<string, unknown>) =>
  Schema.decodeUnknownEffect(ApplicantRecord)(row, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => fail("decode linked applicant")),
  );
const readApplicant = (sql: DatabaseShape, personId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<Record<string, unknown>>`
      SELECT a.applicant_id AS id, a.normalized_email AS "normalizedEmail", a.email,
        a.first_name AS "firstName", a.last_name AS "lastName", a.phone, a.gender,
        a.field_of_study_id AS "fieldOfStudyId", a.year_of_study AS "yearOfStudy",
        a.activation_digest AS "activationDigest"
      FROM public.applicant_account_links l
      JOIN public.admission_applicants a ON a.applicant_id = l.applicant_id
      WHERE l.person_id=${personId}
      ORDER BY l.applicant_id
      FOR UPDATE OF l, a`;
    if (rows.length === 0) return yield* new ReturningAssistantIdentityMissing();
    if (rows.length !== 1) return yield* new ReturningAssistantIdentityAmbiguous();
    return yield* rowApplicant(rows[0]!);
  }).pipe(Effect.catchTag("SqlError", () => Effect.fail(fail("read linked applicant"))));
const readPlacement = (sql: DatabaseShape, personId: string) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ placementId: string }>`
      SELECT placement_id AS "placementId"
      FROM public.assistant_placements
      WHERE person_id=${personId}
      ORDER BY placement_id
      FOR SHARE`;
    if (rows.length === 0) return yield* new ReturningAssistantHistoryMissing();
    return rows[0]!.placementId;
  }).pipe(Effect.catchTag("SqlError", () => Effect.fail(fail("read assistant placements"))));
const readStudy = (sql: DatabaseShape, applicant: typeof ApplicantRecord.Type) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ fieldOfStudyId: string; departmentId: string; active: boolean }>`
      SELECT f.field_of_study_id AS "fieldOfStudyId", f.department_id AS "departmentId", f.active
      FROM public.admission_period_fields_of_study f
      WHERE f.field_of_study_id=${applicant.fieldOfStudyId}
      FOR SHARE`;
    if (rows.length !== 1 || !rows[0]!.active) return yield* new ReturningAssistantStudyMappingInvalid();
    return rows[0]!;
  }).pipe(Effect.catchTag("SqlError", () => Effect.fail(fail("read current study mapping"))));
const readPeriods = (sql: DatabaseShape, departmentId: string, now: string) =>
  sql<ReturningPeriodRow>`
    SELECT p.admission_period_id AS id, p.department_id AS "departmentId", p.semester_id AS "semesterId",
      to_char(p.start_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt",
      to_char(p.end_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "endAt",
      p.revision, p.last_command_id AS "lastCommandId",
      p.semester_id AS "semesterName"
    FROM public.admission_periods p
    JOIN public.admission_period_semesters s ON s.semester_id=p.semester_id
    WHERE p.department_id=${departmentId}
      AND s.start_at <= ${now}::timestamptz AND ${now}::timestamptz < s.end_at
      AND p.start_at <= ${now}::timestamptz AND ${now}::timestamptz < p.end_at
    ORDER BY p.start_at DESC, p.admission_period_id
    FOR SHARE`;
const readTeams = (sql: DatabaseShape, departmentId: string) =>
  sql<{ teamId: string; name: string }>`
    SELECT team_id AS "teamId", name FROM public.organization_teams
    WHERE department_id=${departmentId} ORDER BY team_id FOR SHARE`;
const authorize = (sql: DatabaseShape, context: RegistrationContext) =>
  Effect.gen(function* () {
    const applicant = yield* readApplicant(sql, context.personId);
    const placementId = yield* readPlacement(sql, context.personId);
    const study = yield* readStudy(sql, applicant);
    const periods = yield* readPeriods(sql, study.departmentId, context.now);
    const teams = yield* readTeams(sql, study.departmentId);
    return { applicant, placementId, departmentId: study.departmentId, fieldOfStudyId: study.fieldOfStudyId, periods, teams } satisfies LinkedIdentity;
  }).pipe(Effect.catchTag("SqlError", () => Effect.fail(fail("authorize returning assistant"))));
const projection = (row: ReturningPeriodRow) =>
  Schema.decodeUnknownEffect(AdmissionPeriodProjectionSchema)({
    id: AdmissionPeriodId.make(row.id),
    departmentId: DepartmentId.make(row.departmentId),
    semesterId: SemesterId.make(row.semesterId),
    endAt: row.endAt,
    revision: row.revision,
    lastCommandId: row.lastCommandId,
    eligible: true,
  }, { onExcessProperty: "error" }).pipe(Effect.mapError(() => fail("decode returning period")));
export const readReturningAssistantOptions = (context: RegistrationContext) =>
  Database.use((sql) =>
    Effect.gen(function* () {
      const identity = yield* authorize(sql, context);
      const periods = yield* Effect.forEach(identity.periods, (period) =>
        projection(period).pipe(Effect.map((value) => ({ period: value, semesterName: period.semesterName }))),
      );
      const current = yield* sql<{ revision: string }>`
        SELECT COALESCE(MAX(revision),0)::text AS revision
        FROM public.admission_returning_registrations r
        JOIN public.admission_applications a USING(application_id)
        WHERE a.applicant_id=${identity.applicant.id} AND a.admission_period_id = ANY(${identity.periods.map((p) => p.id)})`;
      return {
        personId: context.personId,
        applicantId: identity.applicant.id,
        departmentId: DepartmentId.make(identity.departmentId),
        fieldOfStudyId: AdmissionFieldOfStudyId.make(identity.fieldOfStudyId),
        periods,
        teams: identity.teams.map((team) => ({ teamId: TeamId.make(team.teamId), name: team.name })),
        currentRevision: Number(current[0]?.revision ?? 0),
      } satisfies ReturningAssistantOptions;
    }),
  );
const findReceipt = (sql: DatabaseShape, commandId: string) =>
  sql<ReceiptRow>`SELECT command_sha256, observation_json FROM public.admission_returning_command_receipts WHERE command_id=${commandId} FOR UPDATE`;
const findApplication = (sql: DatabaseShape, applicantId: string, periodId: string) =>
  sql<ApplicationRow>`
    SELECT application_id AS id, applicant_id AS "applicantId", admission_period_id AS "admissionPeriodId",
      department_id AS "departmentId", field_of_study_id AS "fieldOfStudyId", year_of_study AS "yearOfStudy",
      to_char(submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "submittedAt", revision
    FROM public.admission_applications
    WHERE applicant_id=${applicantId} AND admission_period_id=${periodId}
    FOR UPDATE`;
const registrationDigest = (input: ReturningAssistantRegistrationInput) => sha256Hex(new TextEncoder().encode(canonicalJson(input)));
const registrationId = (digest: string, revision: number) => ReturningRegistrationIdSchema.make(`returning-registration-${sha256Hex(new TextEncoder().encode(`${digest}:${revision}`))}`);
const writeReturningOutbox = (sql: DatabaseShape, input: ReturningAssistantRegistrationInput, application: PublicApplication, applicant: typeof ApplicantRecord.Type, includeAudit: boolean) => {
  const publicCommand = {
    _tag: "SubmitPublicApplication" as const,
    commandId: PublicApplicationCommandIdSchema.make(input.commandId),
    departmentId: application.departmentId,
    firstName: applicant.firstName,
    lastName: applicant.lastName,
    phone: applicant.phone,
    email: applicant.email,
    gender: applicant.gender,
    fieldOfStudyId: applicant.fieldOfStudyId,
    yearOfStudy: input.yearOfStudy,
  };
  const requests = makePublicApplicationOutboxRequests(publicCommand, application, applicant, applicant.email).filter((_request, ordinal) => includeAudit || ordinal < 2);
  return Effect.forEach(requests, (request, ordinal) => sql`
    INSERT INTO public.admission_application_outbox(effect_id,effect_type,application_id,applicant_id,command_id,ordinal,payload_json)
    VALUES(${request.effectId},${request._tag},${request.applicationId},${request.applicantId},${request.commandId},${ordinal},${sql.json(request)})
  `.pipe(Effect.asVoid), { discard: true }).pipe(Effect.as(requests.length));
};
const registerInTransaction = (input: ReturningAssistantRegistrationInput, context: RegistrationContext, sql: DatabaseShape): Effect.Effect<{ observation: ReturningAssistantObservation; replayed: boolean; outboxCount: number }, ReturningAssistantError> =>
  Effect.gen(function* () {
    yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${"returning:" + input.commandId},0))`;
    const identity = yield* authorize(sql, context);
    const period = identity.periods.find((candidate) => candidate.id === input.admissionPeriodId);
    if (period === undefined) return yield* new ReturningAssistantPeriodUnavailable();
    const validTeamIds = new Set(identity.teams.map((team) => team.teamId));
    if (input.teamIds.some((teamId) => !validTeamIds.has(teamId))) return yield* new ReturningAssistantTeamScopeDenied();
    const digest = registrationDigest(input);
    const stored = yield* findReceipt(sql, input.commandId);
    if (stored[0] !== undefined) {
      if (stored[0].command_sha256 !== digest) return yield* new ReturningAssistantCommandConflict();
      const observation = yield* decodeObservation(stored[0].observation_json);
      return { observation, replayed: true, outboxCount: 0 };
    }
    const applications = yield* findApplication(sql, identity.applicant.id, period.id);
    if (applications.length > 1) return yield* new ReturningAssistantIdentityAmbiguous();
    const existing = applications[0];
    let application: ApplicationRow;
    if (existing === undefined) {
      const appDigest = publicApplicationCommandDigest({
        commandId: PublicApplicationCommandIdSchema.make(input.commandId), departmentId: DepartmentId.make(identity.departmentId),
        firstName: identity.applicant.firstName, lastName: identity.applicant.lastName, phone: identity.applicant.phone,
        email: identity.applicant.email, gender: identity.applicant.gender, fieldOfStudyId: identity.applicant.fieldOfStudyId,
        yearOfStudy: input.yearOfStudy,
      });
      const id = PublicApplicationIdSchema.make(`application-${appDigest.slice(0,32)}`);
      yield* sql`INSERT INTO public.admission_applications(application_id,applicant_id,admission_period_id,department_id,field_of_study_id,year_of_study,submitted_at,revision,activation_digest)
        VALUES(${id},${identity.applicant.id},${period.id},${identity.departmentId},${identity.fieldOfStudyId},${input.yearOfStudy},${context.now},0,NULL)`;
      application = { id, applicantId: identity.applicant.id, admissionPeriodId: period.id, departmentId: identity.departmentId, fieldOfStudyId: identity.fieldOfStudyId, yearOfStudy: input.yearOfStudy, submittedAt: context.now, revision: 0 };
    } else {
      if (existing.fieldOfStudyId !== identity.fieldOfStudyId || existing.departmentId !== identity.departmentId) return yield* new ReturningAssistantStudyMappingInvalid();
      yield* sql`UPDATE public.admission_applications SET year_of_study=${input.yearOfStudy}, revision=revision+1 WHERE application_id=${existing.id}`;
      application = { ...existing, yearOfStudy: input.yearOfStudy, revision: existing.revision + 1 };
    }
    const revisions = yield* sql<{ revision: number }>`SELECT COALESCE(MAX(revision),0)::int AS revision FROM public.admission_returning_registrations WHERE application_id=${application.id} FOR UPDATE`;
    const currentRevision = revisions[0]?.revision ?? 0;
    if (input.expectedRevision !== currentRevision) return yield* new ReturningAssistantRevisionConflict({ expectedRevision: input.expectedRevision, currentRevision });
    const nextRevision = currentRevision + 1;
    const rid = registrationId(digest, nextRevision);
    yield* sql`INSERT INTO public.admission_returning_registrations(
      registration_id,application_id,applicant_id,person_id,placement_id,department_id,semester_id,admission_period_id,revision,command_id,
      year_of_study,monday_unavailable,tuesday_unavailable,wednesday_unavailable,thursday_unavailable,friday_unavailable,position_weeks,preferred_group,language,preferred_school,team_interest,registered_at)
      VALUES(${rid},${application.id},${identity.applicant.id},${context.personId},${identity.placementId},${identity.departmentId},${period.semesterId},${period.id},${nextRevision},${input.commandId},
      ${input.yearOfStudy},${input.mondayUnavailable},${input.tuesdayUnavailable},${input.wednesdayUnavailable},${input.thursdayUnavailable},${input.fridayUnavailable},${input.positionWeeks},${input.preferredGroup},${input.language},${input.preferredSchool},${input.teamInterest},${context.now})`;
    yield* sql`INSERT INTO public.admission_returning_registration_placements(registration_id,placement_id) VALUES(${rid},${identity.placementId})`;
    for (const teamId of input.teamIds) yield* sql`INSERT INTO public.admission_returning_registration_teams(registration_id,team_id) VALUES(${rid},${teamId})`;
    yield* sql`INSERT INTO public.admission_returning_registration_audit(registration_id,revision,applicant_id,person_id,command_id,action,occurred_at)
      VALUES(${rid},${nextRevision},${identity.applicant.id},${context.personId},${input.commandId},${existing === undefined ? "Registered" : "Reapplied"},${context.now})`;
    const observation: ReturningAssistantObservation = { _tag: "ReturningAssistantRegistered", commandId: input.commandId, applicationId: PublicApplicationIdSchema.make(application.id), registrationId: rid, revision: nextRevision };
    yield* sql`INSERT INTO public.admission_returning_command_receipts(command_id,command_sha256,command_json,observation_json,registration_id,committed_at)
      VALUES(${input.commandId},${digest},${sql.json(input)},${sql.json(observation)},${rid},${context.now})`;
    const publicApplication = {
      id: PublicApplicationIdSchema.make(application.id),
      applicantId: ApplicantIdSchema.make(application.applicantId),
      admissionPeriodId: AdmissionPeriodId.make(application.admissionPeriodId),
      departmentId: DepartmentId.make(application.departmentId),
      fieldOfStudyId: AdmissionFieldOfStudyId.make(application.fieldOfStudyId),
      yearOfStudy: application.yearOfStudy,
      submittedAt: application.submittedAt,
      revision: application.revision,
      activationDigest: null,
    } satisfies PublicApplication;
    const includeAudit = existing === undefined;
    const outboxCount = yield* writeReturningOutbox(sql, input, publicApplication, identity.applicant, includeAudit);
    if (includeAudit) yield* sql`INSERT INTO public.admission_application_audit(command_id,application_id,applicant_id,action,application_revision,occurred_at)
      VALUES(${input.commandId},${application.id},${application.applicantId},'PublicApplicationSubmitted',${application.revision},${context.now})`;
    return { observation, replayed: false, outboxCount };
  });
export const registerReturningAssistant = (input: unknown, context: RegistrationContext) =>
  Effect.gen(function* () {
    const command = yield* decodeInput(input);
    if (!context.personId) return yield* new ReturningAssistantIdentityMissing();
    return yield* Database.use((sql) => sql.withTransaction(registerInTransaction(command, context, sql)));
  }).pipe(Effect.catchTag("SqlError", () => Effect.fail(fail("returning registration transaction"))));
