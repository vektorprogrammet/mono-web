import { join } from "node:path";
import { Effect, Schema } from "effect";
import { validateCollectorExecutablePathWithServices } from "./api.js";
import { canonicalJson, sha256 } from "./canonical.js";
import {
  type ClaimJourney,
  JourneyHttpClient,
  type JourneyHttpClientShape,
  JourneyProcessExecutor,
  type JourneyProcessHandle,
  type VerifiedSemantics,
} from "./journey-evidence.js";
import {
  ParityCommandExecutor,
  type ParityCommandExecutorShape,
  ParityExecutionEnvironment,
  ParityFileSystem,
  type ParityFileSystemShape,
} from "./services.js";

/**
 * Runtime application for spec 0078.2: executes the three tracer journeys
 * against the real legacy Symfony backend and emits witness artifacts that
 * mirror the native claim-specific-journey-observation/v1 shape. Semantic
 * differences are recorded as observed; nothing is normalized.
 */
const LEGACY_SOURCE_REVISION_REF = "bebab18258da5a0f993dfcc6f09ea5e8af7bf68e";
const LEGACY_PASSWORD = "legacy-e2e-secret-1234";
const BCRYPT_HASH = "$2y$12$nGVfCRII/fc9Hr9w2FZ0zO4M8hKh4TltbC1FaweEiWYr.pgS4w0vO";
const LEGACY_APP_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const APPLICANT_USER_ID = 710;
const APPLICANT_EMAIL = "legacy.applicant-new@example.invalid";
const SEEDED_APPLICANT_EMAIL = "legacy.applicant@example.invalid";
const ALTERNATE_APPLICANT_USER_ID = 711;
const CANCEL_APPLICANT_USER_ID = 712;
const INTERVIEW_ACCEPT_ID = 700;
const INTERVIEW_ALT_ID = 701;
const INTERVIEW_ALT_CODE = "legacy-witness-invite-701";
const INTERVIEW_CANCEL_ID = 702;
const INTERVIEW_CANCEL_CODE = "legacy-witness-invite-702";
const ADMISSION_PERIOD_ID = 700;
const OWNER_DEPARTMENT_ID = 700;
const OTHER_DEPARTMENT_ID = 701;
const FIELD_OF_STUDY_ID = 700;
const SEMESTER_ID = 700;
const SCHEDULE_AT = "2031-09-20 13:30:00";
const BACKEND_PORT = 18_731;
const SQLITE3 = "/nix/store/mn1yslb8qw6nj6mm3vr7ji7pqfyjfmv2-sqlite-3.53.3-bin/bin/sqlite3";

/** Legacy HTTP surface includes PUT (receipt status). Native is GET/POST only. */
type LegacyHttpMethod = "GET" | "POST" | "PUT";
export interface LegacyHttpRequest {
  readonly body?: Parameters<JourneyHttpClientShape["request"]>[0]["body"];
  readonly headers?: Readonly<Record<string, string>>;
  readonly method: LegacyHttpMethod;
  readonly url: string;
}
interface LegacyObservedOperation {
  readonly body_digest: string;
  readonly method: LegacyHttpMethod;
  readonly observation_method: string;
  readonly path_template: string;
  readonly response_digest: string;
  readonly status: number;
}
export interface LegacyJourneyRunRecord {
  readonly artifact_digest: string;
  readonly artifact_pointer: string;
  readonly backend: "legacy_symfony";
  readonly database_digest: string;
  readonly fixture_digest: string;
  readonly intent_ref_id: string;
  readonly journey: ClaimJourney;
  readonly observations: readonly LegacyObservedOperation[];
  readonly result: "passed";
  readonly runner_digest: string;
}

export interface LegacyJourneyRunManifest {
  readonly legacy: readonly LegacyJourneyRunRecord[];
  readonly native_gate: {
    readonly backend: "native_effect";
    readonly reason: string;
    readonly result: "observed_absent" | "ready";
  };
  readonly schema_version: "claim-specific-legacy-journey-run/v1";
  readonly source_revision_ref: string;
}

const LegacyObservedOperationListSchema = Schema.Array(
  Schema.Struct({
    body_digest: Schema.String,
    method: Schema.Literals(["GET", "POST", "PUT"]),
    observation_method: Schema.String,
    path_template: Schema.String,
    response_digest: Schema.String,
    status: Schema.Int,
  }),
);

const JsonUnknownFromText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonText = Schema.decodeUnknownSync(JsonUnknownFromText, {
  onExcessProperty: "error",
});

export const LegacyJourneyObservationArtifactSchema = Schema.Struct({
  artifact_schema_version: Schema.Literal("claim-specific-journey-observation/v1"),
  backend: Schema.Literal("legacy_symfony"),
  database_observation: Schema.Struct({
    digest: Schema.String,
    method: Schema.Literal("fresh_sqlite_read_back"),
    row_counts: Schema.Record(Schema.String, Schema.Int),
  }),
  environment: Schema.Struct({
    api: Schema.Literal("real_legacy_symfony_http_listener"),
    database: Schema.Literal("disposable_loopback_sqlite"),
    network: Schema.Literal("loopback_only"),
    providers: Schema.Literal("disabled"),
  }),
  intent_ref_id: Schema.String,
  legacy_environment: Schema.Struct({
    backend_revision_ref: Schema.Literal(LEGACY_SOURCE_REVISION_REF),
    http_listener: Schema.Literal("php_builtin_server"),
    runtime: Schema.Literal("symfony"),
  }),
  observations: LegacyObservedOperationListSchema,
  result: Schema.Literal("passed"),
  verified_semantics: Schema.Struct({
    assertion_ids: Schema.Array(Schema.String),
    effect_ids: Schema.Array(Schema.String),
    freshness_ids: Schema.Array(Schema.String),
    precondition_ids: Schema.Array(Schema.String),
    rejection_ids: Schema.Array(Schema.String),
  }),
});
export type LegacyJourneyObservationArtifact = typeof LegacyJourneyObservationArtifactSchema.Type;

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
  response: { readonly body: unknown; readonly status: number },
  allowed: readonly number[],
  label: string,
): { readonly body: unknown; readonly status: number } => {
  if (!allowed.includes(response.status)) {
    throw new Error(`${label} returned ${response.status}: ${canonicalJson(response.body)}`);
  }
  return response;
};
const normalizedRequestBody = (body: LegacyHttpRequest["body"]): unknown => {
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
  observations: LegacyObservedOperation[],
  request: LegacyHttpRequest,
  pathTemplate: string,
  observationMethod: string,
): Promise<{ readonly body: unknown; readonly status: number }> => {
  const response = await http.request({
    body: request.body,
    headers: request.headers,
    method: request.method as "POST",
    url: request.url,
  });
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

const sqliteQuery = (
  commands: ParityCommandExecutorShape,
  databasePath: string,
  sql: string,
): string => command(commands, SQLITE3, [databasePath, sql], { timeout: 30_000 }).trim();

const freshDatabaseObservation = (
  commands: ParityCommandExecutorShape,
  databasePath: string,
  sql: string,
): { readonly digest: string; readonly rowCounts: Record<string, number> } => {
  const raw = sqliteQuery(commands, databasePath, sql);
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

const requirePositiveRows = (
  database: { readonly rowCounts: Readonly<Record<string, number>> },
  names: readonly string[],
  label: string,
): void => {
  for (const name of names) {
    if ((database.rowCounts[name] ?? 0) < 1) throw new Error(`${label} missing durable ${name}`);
  }
};
const readJsonColumn = (raw: string): string => raw.replace(/^"|"$/g, "").replaceAll("''", "'");

const requireToken = (raw: string): string => {
  const token = readJsonColumn(requireString(raw.trim(), "interview response code"));
  if (!/^[0-9a-f]{24}$/u.test(token)) throw new Error("interview response code was not 24-hex");
  return token;
};

const routerScript = (documentRoot: string): string => `<?php
// Spec 0078.2 legacy witness router: the PHP built-in server drops
// environment variables from $_SERVER despite variables_order=EGPCS, so every
// request re-exports getenv() into $_SERVER before booting the Symfony front
// controller. Runs from a temporary directory; the legacy checkout is untouched.
foreach (getenv() as $name => $value) {
    $_SERVER[$name] = $value;
    $_ENV[$name] = $value;
}
$_SERVER['REQUEST_URI'] = $_SERVER['REQUEST_URI'] ?? '/';
$_SERVER['SCRIPT_NAME'] = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = '${documentRoot}/index.php';
require '${documentRoot}/index.php';
`;

const serverEnvironment = (temporaryRoot: string, origin: string): Record<string, string> => ({
  APP_DEBUG: "0",
  APP_ENV: "e2e",
  APP_SECRET: LEGACY_APP_SECRET,
  CORS_ALLOW_ORIGIN: origin,
  DATABASE_URL: `sqlite:///${temporaryRoot}/witness.sqlite`,
  DEFAULT_FROM_EMAIL: "e2e@example.invalid",
  DEFAULT_SURVEY_EMAIL: "e2e@example.invalid",
  E2E_PROFILE_PHOTOS: `${temporaryRoot}/uploads/profile`,
  E2E_RECEIPT_IMAGES: `${temporaryRoot}/uploads/receipts`,
  ECONOMY_EMAIL: "e2e@example.invalid",
  GEO_IGNORED_ASNS: "[]",
  GOOGLE_API_CLIENT_ID: "e2e-disabled",
  GOOGLE_API_CLIENT_SECRET: "e2e-disabled",
  GOOGLE_API_REFRESH_TOKEN: "e2e-disabled",
  GATEWAY_API_TOKEN: "e2e-disabled",
  IPINFO_TOKEN: "",
  JWT_PASSPHRASE: "",
  LOG_CHANNEL: "e2e",
  MAILER_DSN: "null://null",
  SLACK_DISABLED: "true",
  SLACK_ENDPOINT: "http://127.0.0.1:9/disabled",
  SMS_DISABLE: "true",
});

const seedSql = (): string => `BEGIN;
INSERT INTO role (id, name, role) VALUES (90, 'Assistant', 'ROLE_USER'), (91, 'Team Member', 'ROLE_TEAM_MEMBER');
INSERT INTO department (id, name, short_name, email, city, address, latitude, longitude, active)
  VALUES (${OWNER_DEPARTMENT_ID}, 'Vektorprogrammet Trondheim', 'Trondheim', 'trondheim@example.invalid', 'Trondheim', 'Høgskoleringen 5', '63.4196', '10.4021', 1),
         (${OTHER_DEPARTMENT_ID}, 'Vektorprogrammet Bergen', 'Bergen', 'bergen@example.invalid', 'Bergen', 'Allégaten 41', '60.3894', '5.3221', 1);
INSERT INTO field_of_study (id, name, short_name, department_id)
  VALUES (${FIELD_OF_STUDY_ID}, 'Datateknologi', 'DATA', ${OWNER_DEPARTMENT_ID});
INSERT INTO semester (id, semester_time, year) VALUES (${SEMESTER_ID}, 'Høst', '2031');
INSERT INTO admission_period (id, department_id, semester_id, start_date, end_date)
  VALUES (${ADMISSION_PERIOD_ID}, ${OWNER_DEPARTMENT_ID}, ${SEMESTER_ID}, '2026-08-01 00:00:00', '2031-12-31 23:59:59');
INSERT INTO user (id, field_of_study_id, last_name, first_name, gender, picture_path, phone, user_name, password, email, is_active, reserved_from_pop_up, last_pop_up_time)
  VALUES (700, ${FIELD_OF_STUDY_ID}, 'Eier', 'Legacy', 1, '', '+47 900 00 700', 'legacy.owner', '${BCRYPT_HASH}', 'legacy.owner@example.invalid', 1, 0, '2026-01-01 00:00:00'),
         (701, ${FIELD_OF_STUDY_ID}, 'Godkjenner', 'Legacy', 1, '', '+47 900 00 701', 'legacy.approver', '${BCRYPT_HASH}', 'legacy.approver@example.invalid', 1, 0, '2026-01-01 00:00:00'),
         (702, ${FIELD_OF_STUDY_ID}, 'Andre', 'Legacy', 1, '', '+47 900 00 702', 'legacy.other', '${BCRYPT_HASH}', 'legacy.other@example.invalid', 1, 0, '2026-01-01 00:00:00'),
         (${APPLICANT_USER_ID}, ${FIELD_OF_STUDY_ID}, 'Søker', 'Legacy', 0, '', '+47 900 00 710', 'legacy.applicant', '${BCRYPT_HASH}', '${SEEDED_APPLICANT_EMAIL}', 1, 0, '2026-01-01 00:00:00'),
         (${ALTERNATE_APPLICANT_USER_ID}, ${FIELD_OF_STUDY_ID}, 'Søker', 'Alternativ', 0, '', '+47 900 00 711', 'legacy.applicant.alt', '${BCRYPT_HASH}', 'legacy.applicant.alt@example.invalid', 1, 0, '2026-01-01 00:00:00'),
         (${CANCEL_APPLICANT_USER_ID}, ${FIELD_OF_STUDY_ID}, 'Søker', 'Avlysning', 0, '', '+47 900 00 712', 'legacy.applicant.cancel', '${BCRYPT_HASH}', 'legacy.applicant.cancel@example.invalid', 1, 0, '2026-01-01 00:00:00');
INSERT INTO user_role (user_id, role_id) VALUES (700, 90), (701, 91), (701, 90), (702, 90), (${APPLICANT_USER_ID}, 90), (${ALTERNATE_APPLICANT_USER_ID}, 90), (${CANCEL_APPLICANT_USER_ID}, 90);
INSERT INTO interview_schema (id, name) VALUES (700, 'Førstegangsintervju');
INSERT INTO interview (id, schema_id, interviewer_id, user_id, interviewed, interview_status, response_code, new_time_message, num_accept_interview_reminders_sent)
  VALUES (${INTERVIEW_ACCEPT_ID}, 700, 701, ${APPLICANT_USER_ID}, 0, 0, NULL, '', 0),
         (${INTERVIEW_ALT_ID}, 700, 701, ${ALTERNATE_APPLICANT_USER_ID}, 0, 0, '${INTERVIEW_ALT_CODE}', '', 0),
         (${INTERVIEW_CANCEL_ID}, 700, 701, ${CANCEL_APPLICANT_USER_ID}, 0, 0, '${INTERVIEW_CANCEL_CODE}', '', 0);
INSERT INTO application (id, admission_period_id, user_id, interview_id, year_of_study, previous_participation, last_edited, created, heard_about_from, team_interest, substitute, double_position, language)
  VALUES (700, ${ADMISSION_PERIOD_ID}, ${APPLICANT_USER_ID}, ${INTERVIEW_ACCEPT_ID}, '3', 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'a:0:{}', 1, 0, 0, 'Norsk'),
         (701, ${ADMISSION_PERIOD_ID}, ${ALTERNATE_APPLICANT_USER_ID}, ${INTERVIEW_ALT_ID}, '3', 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'a:0:{}', 1, 0, 0, 'Norsk'),
         (702, ${ADMISSION_PERIOD_ID}, ${CANCEL_APPLICANT_USER_ID}, ${INTERVIEW_CANCEL_ID}, '3', 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00', 'a:0:{}', 1, 0, 0, 'Norsk');
COMMIT;`;

const writeRouterFile = (
  fileSystem: ParityFileSystemShape,
  temporaryRoot: string,
  serverRoot: string,
): string => {
  const path = join(temporaryRoot, "legacy-witness-router.php");
  fileSystem.writeFile(path, routerScript(join(serverRoot, "public")), "utf8");
  return path;
};

const waitForReady = async (
  http: JourneyHttpClientShape,
  origin: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await http.request({
        method: "GET",
        url: `${origin}/api/admission_periods`,
      });
      if (response.status === 200) return;
    } catch {
      // Bounded readiness retry; no evidence is emitted before success.
    }
    await sleep(250);
  }
  throw new Error("legacy backend readiness timed out");
};

const signIn = async (
  http: JourneyHttpClientShape,
  origin: string,
  username: string,
): Promise<string> => {
  const response = requireStatus(
    await http.request({
      body: { kind: "json", value: { password: LEGACY_PASSWORD, username } },
      headers: { "content-type": "application/json" },
      method: "POST",
      url: `${origin}/api/login`,
    }),
    [200],
    `legacy sign in ${username}`,
  );
  return requireString(asRecord(response.body, `legacy sign in ${username}`).token, "jwt token");
};

const applicantJourney = (
  http: JourneyHttpClientShape,
  commands: ParityCommandExecutorShape,
  fileSystem: ParityFileSystemShape,
  artifactDirectory: string,
  origin: string,
  databasePath: string,
  runnerDigest: string,
  fixtureDigest: string,
): Promise<LegacyJourneyRunRecord> => {
  const observations: LegacyObservedOperation[] = [];
  return (async () => {
    const unauthorized = await observedRequest(
      http,
      observations,
      {
        body: {
          kind: "json",
          value: {
            departmentId: OWNER_DEPARTMENT_ID,
            endDate: "2031-12-31",
            startDate: "2031-09-01",
          },
        },
        headers: { "content-type": "application/json" },
        method: "POST",
        url: `${origin}/api/admin/admission-periods`,
      },
      "/api/admin/admission-periods",
      "authorization_rejection_without_session",
    );
    requireStatus(unauthorized, [401, 403], "period management authorization rejection");
    const catalog = await observedRequest(
      http,
      observations,
      { method: "GET", url: `${origin}/api/admission_periods` },
      "/api/admission_periods",
      "real_http_operation",
    );
    requireStatus(catalog, [200], "admission catalog");
    requireStatus(
      await observedRequest(
        http,
        observations,
        {
          body: {
            kind: "json",
            value: {
              departmentId: OWNER_DEPARTMENT_ID,
              email: APPLICANT_EMAIL,
              fieldOfStudyId: FIELD_OF_STUDY_ID,
              firstName: "Legacy",
              gender: 0,
              lastName: "Søker",
              phone: "+47 900 00 710",
              yearOfStudy: "3",
            },
          },
          headers: { "content-type": "application/json" },
          method: "POST",
          url: `${origin}/api/applications`,
        },
        "/api/applications",
        "real_http_operation",
      ),
      [201],
      "application submit",
    );
    const applicationId = command(
      commands,
      SQLITE3,
      [
        databasePath,
        `SELECT application.id FROM application JOIN user ON user.id = application.user_id WHERE user.email = '${APPLICANT_EMAIL}'`,
      ],
      { timeout: 30_000 },
    ).trim();
    if (!/^\d+$/u.test(applicationId)) throw new Error("application submit was not persisted");
    const duplicate = await observedRequest(
      http,
      observations,
      {
        body: {
          kind: "json",
          value: {
            departmentId: OWNER_DEPARTMENT_ID,
            email: APPLICANT_EMAIL,
            fieldOfStudyId: FIELD_OF_STUDY_ID,
            firstName: "Legacy",
            gender: 0,
            lastName: "Søker",
            phone: "+47 900 00 710",
            yearOfStudy: "3",
          },
        },
        headers: { "content-type": "application/json" },
        method: "POST",
        url: `${origin}/api/applications`,
      },
      "/api/applications",
      "invalid_transition_rejection",
    );
    requireStatus(duplicate, [500], "duplicate application rejection");
    const approverToken = await signIn(http, origin, "legacy.approver@example.invalid");
    const detail = await observedRequest(
      http,
      observations,
      {
        headers: { authorization: `Bearer ${approverToken}` },
        method: "GET",
        url: `${origin}/api/admin/applications/${applicationId}`,
      },
      "/api/admin/applications/{id}",
      "fresh_http_read_after_write",
    );
    requireStatus(detail, [200], "fresh application detail");
    const detailBody = asRecord(detail.body, "application detail");
    if (detailBody.userEmail !== APPLICANT_EMAIL) {
      throw new Error("fresh application detail did not show the submitted applicant");
    }
    const database = freshDatabaseObservation(
      commands,
      databasePath,
      `SELECT json_object('row_counts', json_object('admission_subscribers', (SELECT count(*) FROM admission_subscriber WHERE email = '${APPLICANT_EMAIL}'), 'applications', (SELECT count(*) FROM application JOIN user ON user.id = application.user_id WHERE user.email = '${APPLICANT_EMAIL}'), 'users', (SELECT count(*) FROM user WHERE email = '${APPLICANT_EMAIL}')), 'application', (SELECT json_object('year_of_study', application.year_of_study) FROM application JOIN user ON user.id = application.user_id WHERE user.email = '${APPLICANT_EMAIL}'))`,
    );
    requirePositiveRows(database, ["applications", "admission_subscribers"], "applicant admission");
    return writeLegacyArtifact(
      fileSystem,
      artifactDirectory,
      "applicant_admission",
      "intent://journey:parity:applicant_admission:v1",
      observations,
      database,
      {
        assertion_ids: ["assertion-applicant-admission-submitted"],
        effect_ids: [
          "effect-applicant-admission-activation-requested",
          "effect-applicant-admission-outbox-persisted",
        ],
        freshness_ids: ["freshness-applicant-admission-confirmation"],
        precondition_ids: ["precondition-applicant-admission-period-management"],
        rejection_ids: [],
      },
      runnerDigest,
      fixtureDigest,
    );
  })();
};

const interviewJourney = (
  http: JourneyHttpClientShape,
  commands: ParityCommandExecutorShape,
  fileSystem: ParityFileSystemShape,
  artifactDirectory: string,
  origin: string,
  databasePath: string,
  runnerDigest: string,
  fixtureDigest: string,
): Promise<LegacyJourneyRunRecord> => {
  const observations: LegacyObservedOperation[] = [];
  return (async () => {
    const scheduleUnauthorized = await observedRequest(
      http,
      observations,
      {
        body: {
          kind: "json",
          value: { campus: "Gløshaugen", datetime: SCHEDULE_AT, mapLink: "", room: "K-101" },
        },
        headers: { "content-type": "application/json" },
        method: "POST",
        url: `${origin}/api/admin/interviews/${INTERVIEW_ACCEPT_ID}/schedule`,
      },
      "/api/admin/interviews/{id}/schedule",
      "authorization_rejection_without_session",
    );
    requireStatus(scheduleUnauthorized, [401, 403], "schedule authorization rejection");
    const invalidCapability = await observedRequest(
      http,
      observations,
      { method: "GET", url: `${origin}/api/interview-responses/${"x".repeat(32)}` },
      "/api/interview-responses/{responseCode}",
      "authorization_rejection_without_capability",
    );
    requireStatus(invalidCapability, [404], "response code rejection");
    const approverToken = await signIn(http, origin, "legacy.approver@example.invalid");
    const board = await observedRequest(
      http,
      observations,
      {
        headers: { authorization: `Bearer ${approverToken}` },
        method: "GET",
        url: `${origin}/api/admin/interviews`,
      },
      "/api/admin/interviews",
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
              datetime: SCHEDULE_AT,
              from: "legacy.approver@example.invalid",
              mapLink: "https://maps.example.invalid/legacy-witness",
              message: "Vi ser frem til intervjuet.",
              room: "K-101",
              to: SEEDED_APPLICANT_EMAIL,
            },
          },
          headers: {
            authorization: `Bearer ${approverToken}`,
            "content-type": "application/json",
          },
          method: "POST",
          url: `${origin}/api/admin/interviews/${INTERVIEW_ACCEPT_ID}/schedule`,
        },
        "/api/admin/interviews/{id}/schedule",
        "real_http_operation",
      ),
      [204],
      "schedule interview",
    );
    if (schedule.status !== 204) throw new Error("schedule interview did not return 204");
    const responseCodeRow = sqliteQuery(
      commands,
      databasePath,
      `SELECT response_code FROM interview WHERE id = ${INTERVIEW_ACCEPT_ID}`,
    );
    const responseCode = requireToken(responseCodeRow);
    if (responseCode.length !== 24) {
      throw new Error(`unexpected response code length ${responseCode.length}`);
    }
    const invitation = await observedRequest(
      http,
      observations,
      {
        method: "GET",
        url: `${origin}/api/interview-responses/${responseCode}`,
      },
      "/api/interview-responses/{responseCode}",
      "real_http_operation",
    );
    requireStatus(invitation, [200], "read invitation response");
    if (asRecord(invitation.body, "invitation response").status !== "Ingen svar") {
      throw new Error("scheduled invitation did not report pending state");
    }
    const accept = await observedRequest(
      http,
      observations,
      { method: "POST", url: `${origin}/api/interview-responses/${responseCode}/accept` },
      "/api/interview-responses/{responseCode}/accept",
      "real_http_operation",
    );
    requireStatus(accept, [204], "accept invitation");
    const acceptedBoard = await observedRequest(
      http,
      observations,
      {
        headers: { authorization: `Bearer ${approverToken}` },
        method: "GET",
        url: `${origin}/api/admin/interviews`,
      },
      "/api/admin/interviews",
      "fresh_http_read_after_write",
    );
    requireStatus(acceptedBoard, [200], "fresh scheduling board");
    // The legacy board serializes localized display labels. The successful
    // fresh read is paired with the exact database-state readback below.
    const acceptAgain = await observedRequest(
      http,
      observations,
      { method: "POST", url: `${origin}/api/interview-responses/${responseCode}/accept` },
      "/api/interview-responses/{responseCode}/accept",
      "invalid_transition_rejection",
    );
    requireStatus(acceptAgain, [422], "already responded rejection");
    const altCode = INTERVIEW_ALT_CODE;
    const altInvitation = await observedRequest(
      http,
      observations,
      { method: "GET", url: `${origin}/api/interview-responses/${altCode}` },
      "/api/interview-responses/{responseCode}",
      "real_http_operation",
    );
    requireStatus(altInvitation, [200], "alternate invitation read");
    const requestNewTime = await observedRequest(
      http,
      observations,
      {
        body: { kind: "json", value: { cancelMessage: null, newTimeMessage: "Kun tirsdag." } },
        headers: { "content-type": "application/json" },
        method: "POST",
        url: `${origin}/api/interview-responses/${altCode}/request-new-time`,
      },
      "/api/interview-responses/{responseCode}/request-new-time",
      "real_http_operation",
    );
    requireStatus(requestNewTime, [204], "request new time");
    const cancelCode = INTERVIEW_CANCEL_CODE;
    const cancel = await observedRequest(
      http,
      observations,
      {
        body: { kind: "json", value: { cancelMessage: "Kan ikke delta." } },
        headers: { "content-type": "application/json" },
        method: "POST",
        url: `${origin}/api/interview-responses/${cancelCode}/cancel`,
      },
      "/api/interview-responses/{responseCode}/cancel",
      "real_http_operation",
    );
    requireStatus(cancel, [204], "cancel pending invitation");
    const freshResponse = await observedRequest(
      http,
      observations,
      { method: "GET", url: `${origin}/api/interview-responses/${cancelCode}` },
      "/api/interview-responses/{responseCode}",
      "fresh_http_read_after_write",
    );
    requireStatus(freshResponse, [200], "fresh invitation response");
    if (asRecord(freshResponse.body, "fresh invitation response").status !== "Kansellert") {
      throw new Error("fresh invitation response did not show cancellation");
    }
    const database = freshDatabaseObservation(
      commands,
      databasePath,
      `SELECT json_object('row_counts', json_object('applications', (SELECT count(*) FROM application), 'interviews', (SELECT count(*) FROM interview), 'response_codes', (SELECT count(*) FROM interview WHERE response_code IS NOT NULL)), 'interviews', (SELECT json_group_array(json_object('id', id, 'status', interview_status, 'has_code', response_code IS NOT NULL, 'cancel_message', cancel_message IS NOT NULL, 'new_time_message', new_time_message IS NOT NULL)) FROM (SELECT id, interview_status, response_code, cancel_message, new_time_message FROM interview ORDER BY id)))`,
    );
    requirePositiveRows(database, ["interviews", "response_codes"], "interview invitation");
    return writeLegacyArtifact(
      fileSystem,
      artifactDirectory,
      "interview_invitation",
      "intent://composition:recruitment:interview-scheduling-invitation-response:v1",
      observations,
      database,
      {
        assertion_ids: [
          "assertion-interview-invitation-scheduled",
          "assertion-interview-invitation-rejected",
        ],
        effect_ids: ["effect-interview-invitation-notification-requested"],
        freshness_ids: [
          "freshness-interview-invitation-response",
          "freshness-interview-invitation-scheduling-board",
        ],
        precondition_ids: [
          "precondition-interview-invitation-interviewer-scope",
          "precondition-interview-invitation-response-capability",
        ],
        rejection_ids: ["rejection-interview-invitation-already-responded"],
      },
      runnerDigest,
      fixtureDigest,
    );
  })();
};

const receiptJourney = (
  http: JourneyHttpClientShape,
  commands: ParityCommandExecutorShape,
  fileSystem: ParityFileSystemShape,
  artifactDirectory: string,
  origin: string,
  databasePath: string,
  runnerDigest: string,
  fixtureDigest: string,
): Promise<LegacyJourneyRunRecord> => {
  const observations: LegacyObservedOperation[] = [];
  return (async () => {
    const adminUnauthorized = await observedRequest(
      http,
      observations,
      { method: "GET", url: `${origin}/api/admin/receipts` },
      "/api/admin/receipts",
      "authorization_rejection_without_session",
    );
    requireStatus(adminUnauthorized, [401, 403], "admin receipts authorization rejection");
    const ownerUnauthorized = await observedRequest(
      http,
      observations,
      { method: "GET", url: `${origin}/api/my/receipts` },
      "/api/my/receipts",
      "authorization_rejection_without_session",
    );
    requireStatus(ownerUnauthorized, [401, 403], "owner receipts authorization rejection");
    const ownerToken = await signIn(http, origin, "legacy.owner@example.invalid");
    const approverToken = await signIn(http, origin, "legacy.approver@example.invalid");
    const submit = requireStatus(
      await observedRequest(
        http,
        observations,
        {
          body: {
            kind: "json",
            value: {
              description: "Bussbillett kurs",
              receiptDate: "2026-09-01",
              sum: 199.5,
            },
          },
          headers: {
            authorization: `Bearer ${ownerToken}`,
            "content-type": "application/json",
          },
          method: "POST",
          url: `${origin}/api/receipts`,
        },
        "/api/receipts",
        "real_http_operation",
      ),
      [201],
      "receipt submit",
    );
    const receiptIdValue = asRecord(submit.body, "receipt submit response").id;
    if (
      (typeof receiptIdValue !== "number" || !Number.isSafeInteger(receiptIdValue)) &&
      (typeof receiptIdValue !== "string" || !/^\d+$/u.test(receiptIdValue))
    ) {
      throw new Error("receipt id was absent");
    }
    const receiptId = String(receiptIdValue);
    const ownerList = await observedRequest(
      http,
      observations,
      {
        headers: { authorization: `Bearer ${ownerToken}` },
        method: "GET",
        url: `${origin}/api/my/receipts`,
      },
      "/api/my/receipts",
      "real_http_operation",
    );
    requireStatus(ownerList, [200], "owner receipt list");
    if (!canonicalJson(ownerList.body).includes('"pending"')) {
      throw new Error("owner receipt list did not show pending status");
    }
    const approvalQueue = await observedRequest(
      http,
      observations,
      {
        headers: { authorization: `Bearer ${approverToken}` },
        method: "GET",
        url: `${origin}/api/admin/receipts`,
      },
      "/api/admin/receipts",
      "real_http_operation",
    );
    requireStatus(approvalQueue, [200], "approval queue");
    const reject = await observedRequest(
      http,
      observations,
      {
        body: { kind: "json", value: { status: "rejected" } },
        headers: {
          authorization: `Bearer ${approverToken}`,
          "content-type": "application/json",
        },
        method: "PUT",
        url: `${origin}/api/admin/receipts/${receiptId}/status`,
      },
      "/api/admin/receipts/{id}/status",
      "real_http_operation",
    );
    requireStatus(reject, [204], "receipt rejection");
    const rejectedReadback = await observedRequest(
      http,
      observations,
      {
        headers: { authorization: `Bearer ${ownerToken}` },
        method: "GET",
        url: `${origin}/api/my/receipts`,
      },
      "/api/my/receipts",
      "fresh_http_read_after_write",
    );
    requireStatus(rejectedReadback, [200], "rejected receipt state readback");
    if (!canonicalJson(rejectedReadback.body).includes('"rejected"')) {
      throw new Error("receipt did not transition to rejected");
    }
    const refund = await observedRequest(
      http,
      observations,
      {
        body: { kind: "json", value: { status: "refunded" } },
        headers: {
          authorization: `Bearer ${approverToken}`,
          "content-type": "application/json",
        },
        method: "PUT",
        url: `${origin}/api/admin/receipts/${receiptId}/status`,
      },
      "/api/admin/receipts/{id}/status",
      "invalid_transition_rejection",
    );
    requireStatus(refund, [500, 422], "invalid transition rejection");
    const refundedReadback = await observedRequest(
      http,
      observations,
      {
        headers: { authorization: `Bearer ${ownerToken}` },
        method: "GET",
        url: `${origin}/api/my/receipts`,
      },
      "/api/my/receipts",
      "fresh_http_read_after_write",
    );
    if (!canonicalJson(refundedReadback.body).includes('"rejected"')) {
      throw new Error("invalid refund transition changed the rejected receipt");
    }
    const repeatRejected = await observedRequest(
      http,
      observations,
      {
        body: { kind: "json", value: { status: "rejected" } },
        headers: {
          authorization: `Bearer ${approverToken}`,
          "content-type": "application/json",
        },
        method: "PUT",
        url: `${origin}/api/admin/receipts/${receiptId}/status`,
      },
      "/api/admin/receipts/{id}/status",
      "real_http_operation",
    );
    if (repeatRejected.status !== 204) {
      throw new Error("repeat same-status update did not return 204");
    }
    const freshOwnerList = await observedRequest(
      http,
      observations,
      {
        headers: { authorization: `Bearer ${ownerToken}` },
        method: "GET",
        url: `${origin}/api/my/receipts`,
      },
      "/api/my/receipts",
      "fresh_http_read_after_write",
    );
    requireStatus(freshOwnerList, [200], "fresh owner list");
    const freshApprovalList = await observedRequest(
      http,
      observations,
      {
        headers: { authorization: `Bearer ${approverToken}` },
        method: "GET",
        url: `${origin}/api/admin/receipts`,
      },
      "/api/admin/receipts",
      "fresh_http_read_after_write",
    );
    requireStatus(freshApprovalList, [200], "fresh approval list");
    const database = freshDatabaseObservation(
      commands,
      databasePath,
      `SELECT json_object('row_counts', json_object('receipt_events', (SELECT count(*) FROM sqlite_master WHERE name = 'receipt_event' AND type = 'table'), 'receipts', (SELECT count(*) FROM receipt)), 'receipt', (SELECT json_object('status', status, 'has_refund_date', refund_date IS NOT NULL) FROM receipt WHERE id = ${receiptId}))`,
    );
    requirePositiveRows(database, ["receipts"], "owner approval");
    return writeLegacyArtifact(
      fileSystem,
      artifactDirectory,
      "owner_approval",
      "intent://composition:receipts:owner-scoped-approval:v1",
      observations,
      database,
      {
        assertion_ids: [
          "assertion-owner-approval-owner-scoped-list",
          "assertion-owner-approval-queue-scoped",
          "assertion-owner-approval-rejected",
          "assertion-owner-approval-submitted-pending",
        ],
        effect_ids: [
          "effect-owner-approval-decision-audit-persisted",
          "effect-owner-approval-submission-audit-persisted",
        ],
        freshness_ids: [
          "freshness-owner-approval-approval-list",
          "freshness-owner-approval-owner-list",
        ],
        precondition_ids: [
          "precondition-owner-approval-approver-scope",
          "precondition-owner-approval-owner-session",
        ],
        rejection_ids: ["rejection-owner-approval-not-pending"],
      },
      runnerDigest,
      fixtureDigest,
    );
  })();
};

const writeLegacyArtifact = (
  fileSystem: ParityFileSystemShape,
  artifactDirectory: string,
  journey: ClaimJourney,
  intentRefId: string,
  observations: readonly LegacyObservedOperation[],
  database: { readonly digest: string; readonly rowCounts: Record<string, number> },
  verifiedSemantics: VerifiedSemantics,
  runnerDigest: string,
  fixtureDigest: string,
): LegacyJourneyRunRecord => {
  const artifact: LegacyJourneyObservationArtifact = {
    artifact_schema_version: "claim-specific-journey-observation/v1",
    backend: "legacy_symfony",
    database_observation: {
      digest: database.digest,
      method: "fresh_sqlite_read_back",
      row_counts: database.rowCounts,
    },
    environment: {
      api: "real_legacy_symfony_http_listener",
      database: "disposable_loopback_sqlite",
      network: "loopback_only",
      providers: "disabled",
    },
    intent_ref_id: intentRefId,
    legacy_environment: {
      backend_revision_ref: LEGACY_SOURCE_REVISION_REF,
      http_listener: "php_builtin_server",
      runtime: "symfony",
    },
    observations,
    result: "passed",
    verified_semantics: verifiedSemantics,
  };
  Schema.decodeUnknownSync(LegacyJourneyObservationArtifactSchema, {
    onExcessProperty: "error",
  })(artifact);
  const bytes = canonicalJson(artifact);
  const fileName = `${journey}-legacy-symfony.json`;
  fileSystem.writeFile(join(artifactDirectory, fileName), bytes, "utf8");
  return {
    artifact_digest: sha256(bytes),
    artifact_pointer: `artifacts/${fileName}`,
    backend: "legacy_symfony",
    database_digest: database.digest,
    fixture_digest: fixtureDigest,
    intent_ref_id: intentRefId,
    journey,
    observations,
    result: "passed",
    runner_digest: runnerDigest,
  };
};

export const runClaimSpecificLegacyJourneyEvidence = (
  config: LegacyJourneyConfig,
): Effect.Effect<
  LegacyJourneyRunManifest,
  JourneyEvidenceError,
  | JourneyHttpClient
  | JourneyProcessExecutor
  | ParityCommandExecutor
  | ParityExecutionEnvironment
  | ParityFileSystem
> =>
  Effect.gen(function* () {
    const commands = yield* ParityCommandExecutor;
    yield* ParityExecutionEnvironment;
    const fileSystem = yield* ParityFileSystem;
    const http = yield* JourneyHttpClient;
    const processes = yield* JourneyProcessExecutor;
    return yield* Effect.tryPromise({
      try: async () => {
        const php = validateCollectorExecutablePathWithServices(
          fileSystem,
          "php",
          config.phpExecutable,
        );
        if (php === null) throw new Error("LEGACY_PHP_EXECUTABLE_UNVERIFIED");
        const temporaryRoot = fileSystem.makeTempDirectory(
          join(fileSystem.temporaryDirectory(), "mono-web-legacy-witness-"),
        );
        const uploads = join(temporaryRoot, "uploads");
        fileSystem.makeDirectory(join(uploads, "receipts"), { recursive: true });
        fileSystem.makeDirectory(join(uploads, "profile"), { recursive: true });
        fileSystem.makeDirectory(config.artifactDirectory, { recursive: true });
        const serverRoot = join(config.legacyRepositoryRoot, "apps/server");
        const databasePath = join(temporaryRoot, "witness.sqlite");
        const routerPath = writeRouterFile(fileSystem, temporaryRoot, serverRoot);
        const origin = `http://127.0.0.1:${BACKEND_PORT}`;
        const fixtureDigest = sha256(canonicalJson(seedSql()));
        let backend: JourneyProcessHandle | undefined;
        try {
          command(commands, php.path, ["bin/console", "doctrine:schema:create", "--env=e2e"], {
            cwd: serverRoot,
            env: serverEnvironment(temporaryRoot, origin),
            timeout: 300_000,
          });
          command(commands, SQLITE3, [databasePath, seedSql()], { timeout: 60_000 });
          backend = await processes.start(
            php.path,
            ["-d", "variables_order=EGPCS", "-S", `127.0.0.1:${BACKEND_PORT}`, routerPath],
            {
              cwd: serverRoot,
              env: serverEnvironment(temporaryRoot, origin),
            },
          );
          await waitForReady(http, origin, (milliseconds) => processes.sleep(milliseconds));
          const runnerDigest = sha256(fileSystem.readBytes(config.runnerSourcePath));
          const legacy = [
            await applicantJourney(
              http,
              commands,
              fileSystem,
              config.artifactDirectory,
              origin,
              databasePath,
              runnerDigest,
              fixtureDigest,
            ),
            await interviewJourney(
              http,
              commands,
              fileSystem,
              config.artifactDirectory,
              origin,
              databasePath,
              runnerDigest,
              fixtureDigest,
            ),
            await receiptJourney(
              http,
              commands,
              fileSystem,
              config.artifactDirectory,
              origin,
              databasePath,
              runnerDigest,
              fixtureDigest,
            ),
          ];
          return {
            legacy,
            native_gate: {
              backend: "native_effect",
              reason: "NATIVE_EVIDENCE_COLLECTED_BY_SEPARATE_NATIVE_RUN",
              result: "ready",
            },
            schema_version: "claim-specific-legacy-journey-run/v1",
            source_revision_ref: LEGACY_SOURCE_REVISION_REF,
          } satisfies LegacyJourneyRunManifest;
        } finally {
          if (backend !== undefined) await processes.stop(backend);
          command(commands, php.path, ["bin/console", "cache:clear", "--env=e2e", "--no-warmup"], {
            cwd: serverRoot,
            env: serverEnvironment(temporaryRoot, origin),
            timeout: 120_000,
          });
          fileSystem.remove(temporaryRoot, { force: true, recursive: true });
        }
      },
      catch: (cause) =>
        new JourneyEvidenceError({
          detail: cause instanceof Error ? cause.message : "legacy journey failed",
        }),
    });
  });

export interface LegacyJourneyConfig {
  readonly artifactDirectory: string;
  readonly legacyRepositoryRoot: string;
  readonly phpExecutable: string;
  readonly runnerSourcePath: string;
}

export class JourneyEvidenceError extends Schema.TaggedError<JourneyEvidenceError>()(
  "JourneyEvidenceError",
  { detail: Schema.String },
) {}

export { JourneyHttpClient } from "./journey-evidence.js";
