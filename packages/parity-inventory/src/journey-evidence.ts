import { join } from "node:path";
import { Context, Effect, Schema } from "effect";
import { resolveCollectorExecutablesWithServices } from "./api.js";
import { canonicalJson, sha256 } from "./canonical.js";
import {
  ParityCommandExecutor,
  type ParityCommandExecutorShape,
  ParityExecutionEnvironment,
  ParityFileSystem,
  type ParityFileSystemShape,
} from "./services.js";

/** Runtime application for spec 0078.1. Authority is supplied by services. */

export type ClaimJourney = "applicant_admission" | "interview_invitation" | "owner_approval";
export type HttpMethod = "GET" | "POST";

export interface JourneyJsonBody {
  readonly kind: "json";
  readonly value: unknown;
}

export interface JourneyMultipartBody {
  readonly kind: "multipart";
  readonly fields: Readonly<Record<string, string>>;
  readonly file: {
    readonly bytes: Uint8Array;
    readonly contentType: "image/png";
    readonly fieldName: "file";
    readonly name: string;
  };
}

export interface JourneyHttpRequest {
  readonly body?: JourneyJsonBody | JourneyMultipartBody;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: HttpMethod;
  readonly url: string;
}

export interface JourneyHttpResponse {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface JourneyHttpClientShape {
  readonly request: (request: JourneyHttpRequest) => Promise<JourneyHttpResponse>;
}

export class JourneyHttpClient extends Context.Service<JourneyHttpClient, JourneyHttpClientShape>()(
  "@monoweb/parity-inventory/JourneyHttpClient",
) {}

export interface JourneyProcessHandle {
  readonly id: string;
}

export interface JourneyProcessExecutorShape {
  readonly start: (
    executable: string,
    arguments_: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string | undefined>>;
    },
  ) => Promise<JourneyProcessHandle>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly stop: (handle: JourneyProcessHandle) => Promise<void>;
}

export class JourneyProcessExecutor extends Context.Service<
  JourneyProcessExecutor,
  JourneyProcessExecutorShape
>()("@monoweb/parity-inventory/JourneyProcessExecutor") {}

export class JourneyEvidenceError extends Schema.TaggedError<JourneyEvidenceError>()(
  "JourneyEvidenceError",
  { detail: Schema.String },
) {}

const ObservedOperationSchema = Schema.Struct({
  body_digest: Schema.String,
  method: Schema.Literals(["GET", "POST"]),
  observation_method: Schema.String,
  path_template: Schema.String,
  response_digest: Schema.String,
  status: Schema.Int,
});
export type ObservedOperation = typeof ObservedOperationSchema.Type;
export const JourneyObservationArtifactSchema = Schema.Struct({
  artifact_schema_version: Schema.Literal("claim-specific-journey-observation/v1"),
  backend: Schema.Literal("native_effect"),
  database_observation: Schema.Struct({
    digest: Schema.String,
    method: Schema.Literal("fresh_psql_read_back"),
    row_counts: Schema.Record(Schema.String, Schema.Int),
  }),
  environment: Schema.Struct({
    api: Schema.Literal("real_native_effect_http_listener"),
    database: Schema.Literal("disposable_loopback_postgresql"),
    network: Schema.Literal("loopback_only"),
    providers: Schema.Literal("disabled"),
  }),
  intent_ref_id: Schema.String,
  observations: Schema.Array(ObservedOperationSchema),
  result: Schema.Literal("passed"),
});
export type JourneyObservationArtifact = typeof JourneyObservationArtifactSchema.Type;

export interface JourneyRunRecord {
  readonly artifact_digest: string;
  readonly artifact_pointer: string;
  readonly backend: "native_effect";
  readonly database_digest: string;
  readonly fixture_digest: string;
  readonly intent_ref_id: string;
  readonly journey: ClaimJourney;
  readonly observations: readonly ObservedOperation[];
  readonly result: "passed";
  readonly runner_digest: string;
}

export interface NativeJourneyRunManifest {
  readonly schema_version: "claim-specific-journey-run/v1";
  readonly legacy_gate: {
    readonly backend: "legacy_symfony";
    readonly result: "observed_absent" | "ready";
    readonly reason: string;
  };
  readonly native: readonly JourneyRunRecord[];
}

export interface NativeJourneyConfig {
  readonly artifactDirectory: string;
  readonly repositoryRoot: string;
  readonly runnerSourcePath: string;
}

const JsonUnknownFromText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonText = Schema.decodeUnknownSync(JsonUnknownFromText, {
  onExcessProperty: "error",
});

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
};

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} was absent`);
  return value;
};

const requireStatus = (
  response: JourneyHttpResponse,
  allowed: readonly number[],
  label: string,
): JourneyHttpResponse => {
  if (!allowed.includes(response.status)) {
    throw new Error(`${label} returned ${response.status}: ${canonicalJson(response.body)}`);
  }
  return response;
};

const normalizedRequestBody = (body: JourneyHttpRequest["body"]): unknown => {
  if (body === undefined) return null;
  if (body.kind === "json") return body.value;
  return {
    fields: body.fields,
    file: {
      byte_length: body.file.bytes.byteLength,
      content_type: body.file.contentType,
      field_name: body.file.fieldName,
      name: body.file.name,
      sha256: sha256(body.file.bytes),
    },
  };
};

const observedRequest = async (
  http: JourneyHttpClientShape,
  observations: ObservedOperation[],
  request: JourneyHttpRequest,
  pathTemplate: string,
  observationMethod: string,
): Promise<JourneyHttpResponse> => {
  const response = await http.request(request);
  observations.push({
    body_digest: sha256(canonicalJson(normalizedRequestBody(request.body))),
    method: request.method,
    observation_method: observationMethod,
    path_template: pathTemplate,
    response_digest: sha256(canonicalJson({ body: response.body, status: response.status })),
    status: response.status,
  });
  return response;
};

const command = (
  commands: ParityCommandExecutorShape,
  executable: string,
  arguments_: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly timeout?: number;
  } = {},
): string =>
  commands.executeText(executable, arguments_, {
    ...options,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

const nixPostgres = (
  commands: ParityCommandExecutorShape,
  arguments_: readonly string[],
  options: Parameters<typeof command>[3] = {},
): string =>
  command(commands, "nix", ["shell", "nixpkgs#postgresql_17", "--command", ...arguments_], {
    ...options,
    timeout: options.timeout ?? 300_000,
  });

const psql = (
  commands: ParityCommandExecutorShape,
  repositoryRoot: string,
  postgresUrl: string,
  sql: string,
): string =>
  nixPostgres(
    commands,
    [
      "psql",
      postgresUrl,
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      "--command",
      sql,
    ],
    { cwd: repositoryRoot },
  ).trim();

const fixedPng = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

const schedulingSeedSql = `
BEGIN;
INSERT INTO admission_period_departments (department_id, name) VALUES ('department-native-claim-0078', 'Trondheim');
INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES ('semester-native-claim-0078', '2031-08-01T00:00:00.000Z', '2032-01-01T00:00:00.000Z');
INSERT INTO admission_periods (admission_period_id, department_id, semester_id, start_at, end_at, revision, last_command_id) VALUES ('admission-period-native-claim-0078', 'department-native-claim-0078', 'semester-native-claim-0078', '2031-09-01T00:00:00.000Z', '2031-10-01T00:00:00.000Z', 0, 'period-native-claim-0078');
INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name, active) VALUES ('field-native-claim-0078', 'department-native-claim-0078', 'Datateknologi', TRUE);
INSERT INTO admission_applicants (applicant_id, normalized_email, email, first_name, last_name, phone, gender, field_of_study_id, year_of_study, activation_digest) VALUES ('applicant-native-claim-0078', 'scheduled.applicant@example.invalid', 'scheduled.applicant@example.invalid', 'Sofie', 'Søker', '90000078', 1, 'field-native-claim-0078', 3, NULL);
INSERT INTO admission_applications (application_id, applicant_id, admission_period_id, department_id, field_of_study_id, year_of_study, submitted_at, revision) VALUES ('application-native-claim-0078', 'applicant-native-claim-0078', 'admission-period-native-claim-0078', 'department-native-claim-0078', 'field-native-claim-0078', 3, '2031-09-10T10:00:00.000Z', 0);
INSERT INTO organization_departments (department_id, name, short_name, email, city, active, revision) VALUES ('department-native-claim-0078', 'Vektorprogrammet Trondheim', 'Trondheim', 'trondheim@example.invalid', 'Trondheim', TRUE, 0);
INSERT INTO person_profiles (person_id, first_name, last_name, revision) VALUES ('person-native-claim-leader-0078', 'Lina', 'Lagleder', 0), ('person-native-claim-interviewer-0078', 'Irene', 'Intervjuer', 0);
INSERT INTO person_contact_profiles (person_id, email, phone, revision) VALUES ('person-native-claim-leader-0078', 'claim.leader@example.invalid', '+47 900 00 078', 0), ('person-native-claim-interviewer-0078', 'claim.interviewer@example.invalid', '+47 900 00 079', 0);
INSERT INTO organization_teams (team_id, department_id, name, active, revision) VALUES ('team-native-claim-0078', 'department-native-claim-0078', 'Rekruttering', TRUE, 0);
INSERT INTO organization_memberships (membership_id, person_id, team_id, deleted_team_name, start_at, end_at, position_id, is_team_leader, is_suspended, revision) VALUES ('membership-native-claim-leader-0078', 'person-native-claim-leader-0078', 'team-native-claim-0078', NULL, '2020-01-01T00:00:00.000Z', NULL, 'teamleader', TRUE, FALSE, 0), ('membership-native-claim-interviewer-0078', 'person-native-claim-interviewer-0078', 'team-native-claim-0078', NULL, '2020-01-01T00:00:00.000Z', NULL, 'interviewer', FALSE, FALSE, 0);
INSERT INTO recruitment_interview_schemas (interview_schema_id, name, question_count, active, revision) VALUES ('interview-schema-native-claim-0078', 'Førstegangsintervju', 1, TRUE, 0);
INSERT INTO recruitment_interview_schema_questions (interview_schema_id, question_id, ordinal, prompt, help_text, kind, alternatives) VALUES ('interview-schema-native-claim-0078', 'interview-schema-native-claim-0078-q0', 0, 'Question 0', NULL, 'text', '[]'::jsonb);
INSERT INTO recruitment_interviews (interview_id, application_id, department_id, interviewer_person_id, interview_schema_id, assigned_by_person_id, assigned_at, revision) VALUES ('interview-native-claim-0078', 'application-native-claim-0078', 'department-native-claim-0078', 'person-native-claim-interviewer-0078', 'interview-schema-native-claim-0078', 'person-native-claim-leader-0078', '2031-09-12T09:00:00.000Z', 0);
COMMIT;`;

const applicantReferenceSeedSql = `
INSERT INTO admission_period_departments (department_id, name) VALUES ('department-applicant-claim-0078', 'Bergen');
INSERT INTO admission_period_semesters (semester_id, start_at, end_at) VALUES ('semester-applicant-claim-0078', '2031-08-01T00:00:00.000Z', '2031-12-31T00:00:00.000Z');
INSERT INTO admission_period_fields_of_study (field_of_study_id, department_id, name, active) VALUES ('field-applicant-claim-0078', 'department-applicant-claim-0078', 'Matematikk', TRUE);
INSERT INTO organization_departments (department_id, name, short_name, email, city, active, revision) VALUES ('department-applicant-claim-0078', 'Vektorprogrammet Bergen', 'Bergen', 'bergen@example.invalid', 'Bergen', TRUE, 0);
INSERT INTO organization_teams (team_id, department_id, name, active, revision) VALUES ('team-applicant-claim-0078', 'department-applicant-claim-0078', 'Rekruttering', TRUE, 0);
INSERT INTO person_profiles (person_id, first_name, last_name, revision) VALUES ('person-applicant-claim-leader-0078', 'Alma', 'Lagleder', 0);
INSERT INTO person_contact_profiles (person_id, email, phone, revision) VALUES ('person-applicant-claim-leader-0078', 'applicant.claim.leader@example.invalid', '+47 900 00 780', 0);
INSERT INTO organization_memberships (membership_id, person_id, team_id, deleted_team_name, start_at, end_at, position_id, is_team_leader, is_suspended, revision) VALUES ('membership-applicant-claim-leader-0078', 'person-applicant-claim-leader-0078', 'team-applicant-claim-0078', NULL, '2020-01-01T00:00:00.000Z', NULL, 'teamleader', TRUE, FALSE, 0);
INSERT INTO organization_global_administrator_grants (grant_id, person_id, start_at, end_at, revision) VALUES ('global-admin-applicant-claim-0078', 'person-applicant-claim-leader-0078', '2020-01-01T00:00:00.000Z', NULL, 0);`;

const fixtureDigest = sha256(
  canonicalJson({ applicantReferenceSeedSql, schedulingSeedSql, fixedPng: sha256(fixedPng) }),
);

const signIn = async (
  http: JourneyHttpClientShape,
  origin: string,
  email: string,
  password: string,
): Promise<string> => {
  const response = requireStatus(
    await http.request({
      body: { kind: "json", value: { email, password } },
      headers: { "content-type": "application/json" },
      method: "POST",
      url: `${origin}/api/auth/sign-in/email`,
    }),
    [200],
    `sign in ${email}`,
  );
  const setCookie = response.headers["set-cookie"] ?? "";
  const session = setCookie
    .split("\n")
    .map((value) => value.trim().split(";", 1)[0] ?? "")
    .find(
      (value) =>
        value.startsWith("better-auth.session_token=") ||
        value.startsWith("__Secure-better-auth.session_token="),
    );
  if (session === undefined) throw new Error(`sign in ${email} returned no session cookie`);
  const sessionCheck = await http.request({
    headers: { cookie: session },
    method: "GET",
    url: `${origin}/api/auth/get-session`,
  });
  const sessionBody = asRecord(sessionCheck.body, "session verification");
  if (sessionCheck.status !== 200 || sessionBody.session == null || sessionBody.user == null) {
    throw new Error(
      `sign in ${email} session verification failed with ${sessionCheck.status}: ${canonicalJson(sessionCheck.body)}`,
    );
  }
  return session;
};

const freshDatabaseObservation = (
  commands: ParityCommandExecutorShape,
  repositoryRoot: string,
  postgresUrl: string,
  sql: string,
): { readonly digest: string; readonly rowCounts: Record<string, number> } => {
  const raw = psql(commands, repositoryRoot, postgresUrl, sql);
  const decoded = asRecord(decodeJsonText(raw), "database observation");
  const rowCountsValue = asRecord(decoded.row_counts, "database row counts");
  const rowCounts: Record<string, number> = {};
  for (const [name, value] of Object.entries(rowCountsValue)) {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
      throw new Error(`invalid row count ${name}`);
    rowCounts[name] = Number(value);
  }
  return { digest: sha256(canonicalJson(decoded)), rowCounts };
};

const writeArtifact = (
  fileSystem: ParityFileSystemShape,
  artifactDirectory: string,
  journey: ClaimJourney,
  intentRefId: string,
  observations: readonly ObservedOperation[],
  database: { readonly digest: string; readonly rowCounts: Record<string, number> },
  runnerDigest: string,
): JourneyRunRecord => {
  const artifact: JourneyObservationArtifact = {
    artifact_schema_version: "claim-specific-journey-observation/v1",
    backend: "native_effect",
    database_observation: {
      digest: database.digest,
      method: "fresh_psql_read_back",
      row_counts: database.rowCounts,
    },
    environment: {
      api: "real_native_effect_http_listener",
      database: "disposable_loopback_postgresql",
      network: "loopback_only",
      providers: "disabled",
    },
    intent_ref_id: intentRefId,
    observations,
    result: "passed",
  };
  Schema.decodeUnknownSync(JourneyObservationArtifactSchema, { onExcessProperty: "error" })(
    artifact,
  );
  const bytes = canonicalJson(artifact);
  const fileName = `${journey}-native-effect.json`;
  fileSystem.writeFile(join(artifactDirectory, fileName), bytes, "utf8");
  return {
    artifact_digest: sha256(bytes),
    artifact_pointer: `artifacts/${fileName}`,
    backend: "native_effect",
    database_digest: database.digest,
    fixture_digest: fixtureDigest,
    intent_ref_id: intentRefId,
    journey,
    observations,
    result: "passed",
    runner_digest: runnerDigest,
  };
};

const applicantJourney = async (
  http: JourneyHttpClientShape,
  commands: ParityCommandExecutorShape,
  fileSystem: ParityFileSystemShape,
  config: NativeJourneyConfig,
  origin: string,
  postgresUrl: string,
  runnerDigest: string,
): Promise<JourneyRunRecord> => {
  const observations: ObservedOperation[] = [];
  const unauthorized = await observedRequest(
    http,
    observations,
    { method: "GET", url: `${origin}/api/admin/admission-periods` },
    "/api/admin/admission-periods",
    "authorization_rejection_without_session",
  );
  requireStatus(unauthorized, [401, 403], "applicant admission authorization rejection");
  const catalog = await observedRequest(
    http,
    observations,
    { method: "GET", url: `${origin}/api/applications/catalog` },
    "/api/applications/catalog",
    "real_http_operation",
  );
  requireStatus(catalog, [200], "application catalog");
  const input = {
    commandId: "applicant-claim-submit-0078",
    departmentId: "department-applicant-claim-0078",
    email: "claim-applicant@example.invalid",
    fieldOfStudyId: "field-applicant-claim-0078",
    firstName: "Claim",
    gender: 0,
    lastName: "Applicant",
    phone: "+47 900 00 781",
    yearOfStudy: 3,
  };
  const submitted = requireStatus(
    await observedRequest(
      http,
      observations,
      {
        body: { kind: "json", value: input },
        headers: { "content-type": "application/json" },
        method: "POST",
        url: `${origin}/api/applications`,
      },
      "/api/applications",
      "real_http_operation",
    ),
    [200, 201],
    "application submission",
  );
  const applicationId = requireString(
    asRecord(submitted.body, "submitted application").applicationId,
    "application id",
  );
  const duplicate = await observedRequest(
    http,
    observations,
    {
      body: {
        kind: "json",
        value: {
          ...input,
          commandId: "applicant-claim-duplicate-0078",
          email: "CLAIM-APPLICANT@EXAMPLE.INVALID",
        },
      },
      headers: { "content-type": "application/json" },
      method: "POST",
      url: `${origin}/api/applications`,
    },
    "/api/applications",
    "invalid_transition_rejection",
  );
  requireStatus(duplicate, [409], "duplicate application rejection");
  const confirmation = await observedRequest(
    http,
    observations,
    {
      method: "GET",
      url: `${origin}/api/applications/${encodeURIComponent(applicationId)}/confirmation`,
    },
    "/api/applications/{applicationId}/confirmation",
    "fresh_http_read_after_write",
  );
  requireStatus(confirmation, [200], "application confirmation");
  const database = freshDatabaseObservation(
    commands,
    config.repositoryRoot,
    postgresUrl,
    `SELECT json_build_object('row_counts', json_build_object('applications', (SELECT count(*) FROM admission_applications WHERE application_id = '${applicationId}'), 'audit', (SELECT count(*) FROM admission_application_audit WHERE application_id = '${applicationId}'), 'outbox', (SELECT count(*) FROM admission_application_outbox WHERE application_id = '${applicationId}')), 'state', (SELECT json_build_object('application_id', application_id, 'revision', revision) FROM admission_applications WHERE application_id = '${applicationId}'), 'outbox', (SELECT coalesce(json_agg(json_build_object('ordinal', ordinal, 'status', status) ORDER BY ordinal), '[]'::json) FROM admission_application_outbox WHERE application_id = '${applicationId}'));`,
  );
  return writeArtifact(
    fileSystem,
    config.artifactDirectory,
    "applicant_admission",
    "intent://journey:parity:applicant_admission:v1",
    observations,
    database,
    runnerDigest,
  );
};

const recruitmentJourney = async (
  http: JourneyHttpClientShape,
  commands: ParityCommandExecutorShape,
  fileSystem: ParityFileSystemShape,
  config: NativeJourneyConfig,
  origin: string,
  postgresUrl: string,
  runnerDigest: string,
): Promise<JourneyRunRecord> => {
  const observations: ObservedOperation[] = [];
  const unauthorized = await observedRequest(
    http,
    observations,
    { method: "GET", url: `${origin}/api/admin/recruitment/interviews/scheduling-board` },
    "/api/admin/recruitment/interviews/scheduling-board",
    "authorization_rejection_without_session",
  );
  requireStatus(unauthorized, [401, 403], "recruitment authorization rejection");
  const leaderCookie = await signIn(
    http,
    origin,
    "claim.leader@example.invalid",
    "native-claim-0078-secret-0123456789",
  );
  const board = await observedRequest(
    http,
    observations,
    {
      headers: { cookie: leaderCookie },
      method: "GET",
      url: `${origin}/api/admin/recruitment/interviews/scheduling-board`,
    },
    "/api/admin/recruitment/interviews/scheduling-board",
    "real_http_operation",
  );
  requireStatus(board, [200], "scheduling board");
  const schedule = requireStatus(
    await observedRequest(
      http,
      observations,
      {
        body: {
          kind: "json",
          value: {
            campus: "Gløshaugen",
            commandId: "schedule-native-claim-0078",
            expectedRevision: 0,
            interviewId: "interview-native-claim-0078",
            mapLink: "https://maps.example.invalid/native-claim-0078",
            message: "Vi ser frem til intervjuet.",
            room: "K-101",
            scheduledAt: "2031-09-20T13:30:00.000Z",
          },
        },
        headers: { "content-type": "application/json", cookie: leaderCookie },
        method: "POST",
        url: `${origin}/api/admin/recruitment/interviews/schedule`,
      },
      "/api/admin/recruitment/interviews/schedule",
      "real_http_operation",
    ),
    [200],
    "schedule interview",
  );
  const scheduleBody = asRecord(schedule.body, "schedule response");
  const scheduleObservation = asRecord(scheduleBody.observation, "schedule observation");
  const interviewId = requireString(scheduleObservation.interviewId, "scheduled interview id");
  const capabilityRaw = psql(
    commands,
    config.repositoryRoot,
    postgresUrl,
    `SELECT payload_json->>'responseCapability' FROM recruitment_invitation_outbox WHERE interview_id = '${interviewId}';`,
  );
  const capability = requireString(capabilityRaw, "invitation response capability");
  const capabilityHeaders = { "x-recruitment-invitation-capability": capability };
  const invitation = await observedRequest(
    http,
    observations,
    {
      headers: capabilityHeaders,
      method: "GET",
      url: `${origin}/api/recruitment/invitation-response`,
    },
    "/api/recruitment/invitation-response",
    "real_http_operation",
  );
  requireStatus(invitation, [200], "read invitation response");
  const rejected = await observedRequest(
    http,
    observations,
    {
      body: { kind: "json", value: { message: "Kan ikke delta." } },
      headers: { ...capabilityHeaders, "content-type": "application/json" },
      method: "POST",
      url: `${origin}/api/recruitment/invitation-response/reject`,
    },
    "/api/recruitment/invitation-response/reject",
    "real_http_operation",
  );
  requireStatus(rejected, [204], "reject invitation");
  const invalid = await observedRequest(
    http,
    observations,
    {
      body: { kind: "json", value: {} },
      headers: { ...capabilityHeaders, "content-type": "application/json" },
      method: "POST",
      url: `${origin}/api/recruitment/invitation-response/confirm`,
    },
    "/api/recruitment/invitation-response/confirm",
    "invalid_transition_rejection",
  );
  requireStatus(invalid, [409, 422], "double invitation response rejection");
  const fresh = await observedRequest(
    http,
    observations,
    {
      headers: capabilityHeaders,
      method: "GET",
      url: `${origin}/api/recruitment/invitation-response`,
    },
    "/api/recruitment/invitation-response",
    "fresh_http_read_after_write",
  );
  requireStatus(fresh, [200], "fresh invitation response");
  const database = freshDatabaseObservation(
    commands,
    config.repositoryRoot,
    postgresUrl,
    `SELECT json_build_object('row_counts', json_build_object('schedules', (SELECT count(*) FROM recruitment_interview_schedules WHERE interview_id = '${interviewId}'), 'invitations', (SELECT count(*) FROM recruitment_invitations WHERE interview_id = '${interviewId}'), 'invitation_outbox', (SELECT count(*) FROM recruitment_invitation_outbox WHERE interview_id = '${interviewId}'), 'response_outbox', (SELECT count(*) FROM recruitment_invitation_response_outbox WHERE interview_id = '${interviewId}')), 'invitation', (SELECT json_build_object('response_state', response_state, 'schedule_revision', schedule_revision) FROM recruitment_invitations WHERE interview_id = '${interviewId}'), 'outbox', (SELECT coalesce(json_agg(json_build_object('effect_type', effect_type, 'status', status) ORDER BY ordinal), '[]'::json) FROM recruitment_invitation_response_outbox WHERE interview_id = '${interviewId}'));`,
  );
  return writeArtifact(
    fileSystem,
    config.artifactDirectory,
    "interview_invitation",
    "intent://composition:recruitment:interview-scheduling-invitation-response:v1",
    observations,
    database,
    runnerDigest,
  );
};

const receiptJourney = async (
  http: JourneyHttpClientShape,
  commands: ParityCommandExecutorShape,
  fileSystem: ParityFileSystemShape,
  config: NativeJourneyConfig,
  origin: string,
  postgresUrl: string,
  runnerDigest: string,
): Promise<JourneyRunRecord> => {
  const observations: ObservedOperation[] = [];
  const unauthorized = await observedRequest(
    http,
    observations,
    { method: "GET", url: `${origin}/api/admin/receipts` },
    "/api/admin/receipts",
    "authorization_rejection_without_session",
  );
  requireStatus(unauthorized, [401, 403], "receipt authorization rejection");
  const ownerCookie = await signIn(
    http,
    origin,
    "owner-a.receipt.0037@example.invalid",
    "receipt-approval-0037-password",
  );
  const approverCookie = await signIn(
    http,
    origin,
    "approver-a.receipt.0037@example.invalid",
    "receipt-approval-0037-password",
  );
  const submit = requireStatus(
    await observedRequest(
      http,
      observations,
      {
        body: {
          kind: "multipart",
          fields: {
            amountOre: "12345",
            commandId: "receipt-native-claim-submit-0078",
            description: "Claim-specific owner receipt",
            receiptDate: "2031-09-14",
          },
          file: {
            bytes: fixedPng,
            contentType: "image/png",
            fieldName: "file",
            name: "claim-receipt.png",
          },
        },
        headers: { cookie: ownerCookie },
        method: "POST",
        url: `${origin}/api/receipts/submit`,
      },
      "/api/receipts/submit",
      "real_http_operation",
    ),
    [200, 201],
    "receipt submission",
  );
  const receiptId = requireString(
    asRecord(submit.body, "receipt submission").receiptId,
    "receipt id",
  );
  const ownerRead = await observedRequest(
    http,
    observations,
    { headers: { cookie: ownerCookie }, method: "GET", url: `${origin}/api/receipts` },
    "/api/receipts",
    "real_http_operation",
  );
  requireStatus(ownerRead, [200], "owner receipt read");
  const approvalRead = await observedRequest(
    http,
    observations,
    { headers: { cookie: approverCookie }, method: "GET", url: `${origin}/api/admin/receipts` },
    "/api/admin/receipts",
    "real_http_operation",
  );
  requireStatus(approvalRead, [200], "approval list read");
  const reject = await observedRequest(
    http,
    observations,
    {
      body: {
        kind: "json",
        value: { commandId: "receipt-native-claim-reject-0078", expectedRevision: 0 },
      },
      headers: { "content-type": "application/json", cookie: approverCookie },
      method: "POST",
      url: `${origin}/api/admin/receipts/${encodeURIComponent(receiptId)}/reject`,
    },
    "/api/admin/receipts/{receiptId}/reject",
    "real_http_operation",
  );
  requireStatus(reject, [200], "receipt rejection");
  const invalid = await observedRequest(
    http,
    observations,
    {
      body: {
        kind: "json",
        value: { commandId: "receipt-native-claim-double-reject-0078", expectedRevision: 1 },
      },
      headers: { "content-type": "application/json", cookie: approverCookie },
      method: "POST",
      url: `${origin}/api/admin/receipts/${encodeURIComponent(receiptId)}/reject`,
    },
    "/api/admin/receipts/{receiptId}/reject",
    "invalid_transition_rejection",
  );
  requireStatus(invalid, [409], "terminal receipt transition rejection");
  const fresh = await observedRequest(
    http,
    observations,
    { headers: { cookie: ownerCookie }, method: "GET", url: `${origin}/api/receipts` },
    "/api/receipts",
    "fresh_http_read_after_write",
  );
  requireStatus(fresh, [200], "fresh owner receipt read");
  const database = freshDatabaseObservation(
    commands,
    config.repositoryRoot,
    postgresUrl,
    `SELECT json_build_object('row_counts', json_build_object('receipts', (SELECT count(*) FROM economy_receipts WHERE receipt_id = '${receiptId}'), 'commands', (SELECT count(*) FROM economy_receipt_command_receipts WHERE receipt_id = '${receiptId}'), 'audit', (SELECT count(*) FROM economy_receipt_audit WHERE receipt_id = '${receiptId}'), 'outbox', (SELECT count(*) FROM economy_receipt_outbox WHERE receipt_id = '${receiptId}')), 'receipt', (SELECT json_build_object('status', status, 'revision', revision, 'owner_person_id', owner_person_id) FROM economy_receipts WHERE receipt_id = '${receiptId}'), 'outbox', (SELECT coalesce(json_agg(json_build_object('effect_type', effect_type, 'ordinal', ordinal, 'status', status) ORDER BY command_id, ordinal), '[]'::json) FROM economy_receipt_outbox WHERE receipt_id = '${receiptId}'));`,
  );
  return writeArtifact(
    fileSystem,
    config.artifactDirectory,
    "owner_approval",
    "intent://composition:receipts:owner-scoped-approval:v1",
    observations,
    database,
    runnerDigest,
  );
};

const legacyGate = (
  commands: ParityCommandExecutorShape,
  fileSystem: ParityFileSystemShape,
  environment: Readonly<Record<string, string | undefined>>,
  repositoryRoot: string,
): NativeJourneyRunManifest["legacy_gate"] => {
  const executables = resolveCollectorExecutablesWithServices(fileSystem, undefined, environment);
  if (executables === null) {
    return {
      backend: "legacy_symfony",
      reason: "LEGACY_COLLECTOR_EXECUTABLES_UNAVAILABLE:verified_php_and_bwrap_not_found",
      result: "observed_absent",
    };
  }
  const php = executables.php.path;
  const bwrap = executables.bwrap.path;
  const serverRoot = join(repositoryRoot, "apps/server");
  try {
    command(commands, php, ["-v"], { cwd: serverRoot, timeout: 30_000 });
    command(commands, bwrap, ["--version"], { cwd: serverRoot, timeout: 30_000 });
    const console = commands.spawnText(php, ["bin/console", "about", "--env=e2e"], {
      cwd: serverRoot,
      env: { APP_ENV: "e2e" },
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    if (console.status !== 0) {
      return {
        backend: "legacy_symfony",
        reason: `LEGACY_CONSOLE_BOOT_FAILED:${console.status ?? "signal"}`,
        result: "observed_absent",
      };
    }
    return {
      backend: "legacy_symfony",
      reason: "LEGACY_DISPOSABLE_DATABASE_FIXTURE_PATH_REQUIRES_MYSQL_NOT_PRESENT",
      result: "observed_absent",
    };
  } catch (cause) {
    return {
      backend: "legacy_symfony",
      reason: `LEGACY_PHP_BWRAP_GATE_FAILED:${cause instanceof Error ? cause.message.split("\n", 1)[0] : "unknown"}`,
      result: "observed_absent",
    };
  }
};

export const runClaimSpecificJourneyEvidence = (
  config: NativeJourneyConfig,
): Effect.Effect<
  NativeJourneyRunManifest,
  JourneyEvidenceError,
  | JourneyHttpClient
  | JourneyProcessExecutor
  | ParityCommandExecutor
  | ParityExecutionEnvironment
  | ParityFileSystem
> =>
  Effect.gen(function* () {
    const commands = yield* ParityCommandExecutor;
    const environment = yield* ParityExecutionEnvironment;
    const fileSystem = yield* ParityFileSystem;
    const http = yield* JourneyHttpClient;
    const processes = yield* JourneyProcessExecutor;
    return yield* Effect.tryPromise({
      try: async () => {
        const temporaryRoot = fileSystem.makeTempDirectory(
          join(fileSystem.temporaryDirectory(), "mono-web-claim-evidence-"),
        );
        const postgresData = join(temporaryRoot, "postgres");
        const stagingRoot = join(temporaryRoot, "receipt-staging");
        const committedRoot = join(temporaryRoot, "receipt-committed");
        fileSystem.makeDirectory(stagingRoot, { recursive: true });
        fileSystem.makeDirectory(committedRoot, { recursive: true });
        fileSystem.makeDirectory(config.artifactDirectory, { recursive: true });
        const portSeed = Number.parseInt(sha256(config.repositoryRoot).slice(-4), 16);
        const postgresPort = 46_000 + (portSeed % 1_000);
        const backendPort = postgresPort + 1_000;
        const postgresUrl = `postgres://postgres@127.0.0.1:${postgresPort}/receipt_proof?connect_timeout=1`;
        const origin = `http://127.0.0.1:${backendPort}`;
        const baseEnvironment = { ...environment.environment };
        const betterAuthSecret = "claim-specific-0078-better-auth-secret-0123456789";
        const backendEnvironment = {
          ...baseEnvironment,
          ADMISSION_FIXED_NOW: "2031-09-15T12:00:00.000Z",
          BACKEND_HOST: "127.0.0.1",
          BACKEND_PG_URL: postgresUrl,
          BACKEND_PORT: String(backendPort),
          BETTER_AUTH_SECRET: betterAuthSecret,
          BETTER_AUTH_URL: origin,
          PUBLIC_APPLICATION_EFFECT_MODE: "disabled",
          RECEIPT_COMMITTED_ROOT: committedRoot,
          RECEIPT_E2E_TEST_MODE: "1",
          RECEIPT_MAX_FILE_BYTES: "10485760",
          RECEIPT_STAGING_ROOT: stagingRoot,
        };
        let backend: JourneyProcessHandle | undefined;
        let postgresStarted = false;
        try {
          nixPostgres(
            commands,
            [
              "initdb",
              "-D",
              postgresData,
              "-U",
              "postgres",
              "--auth=trust",
              "--no-locale",
              "--encoding=UTF8",
            ],
            {
              cwd: config.repositoryRoot,
            },
          );
          nixPostgres(
            commands,
            [
              "pg_ctl",
              "-D",
              postgresData,
              "-l",
              join(temporaryRoot, "postgres.log"),
              "-o",
              `-F -p ${postgresPort} -h 127.0.0.1 -k ${temporaryRoot}`,
              "-w",
              "start",
            ],
            { cwd: config.repositoryRoot },
          );
          postgresStarted = true;
          nixPostgres(
            commands,
            [
              "createdb",
              "-h",
              "127.0.0.1",
              "-p",
              String(postgresPort),
              "-U",
              "postgres",
              "receipt_proof",
            ],
            { cwd: config.repositoryRoot },
          );
          backend = await processes.start("bun", ["run", "--cwd", "apps/backend", "start"], {
            cwd: config.repositoryRoot,
            env: backendEnvironment,
          });
          let ready = false;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            try {
              const response = await http.request({ method: "GET", url: `${origin}/health` });
              if (response.status === 200) {
                ready = true;
                break;
              }
            } catch {
              // Bounded readiness retry; no evidence is emitted before success.
            }
            await processes.sleep(250);
          }
          if (!ready) throw new Error("native backend readiness timed out");

          command(commands, "bun", ["apps/dashboard/e2e/native-receipt-approval-seed.mjs"], {
            cwd: config.repositoryRoot,
            env: {
              ...backendEnvironment,
              RECEIPT_APPROVAL_PG_URL: postgresUrl,
            },
            timeout: 300_000,
          });
          psql(commands, config.repositoryRoot, postgresUrl, schedulingSeedSql);
          psql(commands, config.repositoryRoot, postgresUrl, applicantReferenceSeedSql);
          command(commands, "bun", ["run", "identity:seed"], {
            cwd: join(config.repositoryRoot, "packages/database"),
            env: {
              ...backendEnvironment,
              IDENTITY_SEED_PERSONS: canonicalJson([
                {
                  email: "claim.leader@example.invalid",
                  firstName: "Lina",
                  lastName: "Lagleder",
                  password: "native-claim-0078-secret-0123456789",
                  personId: "person-native-claim-leader-0078",
                },
                {
                  email: "claim.interviewer@example.invalid",
                  firstName: "Irene",
                  lastName: "Intervjuer",
                  password: "native-claim-0078-secret-0123456789",
                  personId: "person-native-claim-interviewer-0078",
                },
                {
                  email: "applicant.claim.leader@example.invalid",
                  firstName: "Alma",
                  lastName: "Lagleder",
                  password: "native-claim-0078-secret-0123456789",
                  personId: "person-applicant-claim-leader-0078",
                },
              ]),
              IDENTITY_SEED_PG_URL: postgresUrl,
            },
            timeout: 300_000,
          });
          const applicantLeaderCookie = await signIn(
            http,
            origin,
            "applicant.claim.leader@example.invalid",
            "native-claim-0078-secret-0123456789",
          );
          const period = await http.request({
            body: {
              kind: "json",
              value: {
                commandId: "open-applicant-claim-period-0078",
                departmentId: "department-applicant-claim-0078",
                endAt: "2031-10-01T20:00:00.000Z",
                semesterId: "semester-applicant-claim-0078",
                startAt: "2031-09-01T08:00:00.000Z",
              },
            },
            headers: {
              "content-type": "application/json",
              cookie: applicantLeaderCookie,
            },
            method: "POST",
            url: `${origin}/api/admin/admission-periods`,
          });
          requireStatus(period, [200, 201], "create applicant admission period");

          const runnerDigest = sha256(fileSystem.readBytes(config.runnerSourcePath));
          const native = [
            await applicantJourney(
              http,
              commands,
              fileSystem,
              config,
              origin,
              postgresUrl,
              runnerDigest,
            ),
            await recruitmentJourney(
              http,
              commands,
              fileSystem,
              config,
              origin,
              postgresUrl,
              runnerDigest,
            ),
            await receiptJourney(
              http,
              commands,
              fileSystem,
              config,
              origin,
              postgresUrl,
              runnerDigest,
            ),
          ];
          return {
            legacy_gate: legacyGate(
              commands,
              fileSystem,
              environment.environment,
              config.repositoryRoot,
            ),
            native,
            schema_version: "claim-specific-journey-run/v1",
          } satisfies NativeJourneyRunManifest;
        } finally {
          if (backend !== undefined) await processes.stop(backend);
          if (postgresStarted) {
            try {
              nixPostgres(commands, ["pg_ctl", "-D", postgresData, "-m", "fast", "-w", "stop"], {
                cwd: config.repositoryRoot,
              });
            } catch {
              // Cleanup continues to remove the disposable root; the caller observes primary failures.
            }
          }
          fileSystem.remove(temporaryRoot, { force: true, recursive: true });
        }
      },
      catch: (cause) =>
        new JourneyEvidenceError({
          detail: cause instanceof Error ? cause.message : "claim-specific journey failed",
        }),
    });
  });
