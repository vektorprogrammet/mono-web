import { backendDatabase } from "../../test/database.js";
import {
  SchoolSurveyAdminResource,
  SchoolSurveyAdminListResource,
} from "@vektorprogrammet/domain/surveys";
import { Database, IdentitySnapshot, OAuthCredentialAuthority } from "@vektorprogrammet/database";
import {
  SchoolId,
  SchoolSurveyNotFound,
  SchoolSurveys,
  SemesterId,
  SurveyId,
  SurveyQuestionId,
  encodeSchoolSurveyResultsCsv,
  type CloseSchoolSurveyCommand,
  type CreateSchoolSurveyCommand,
  type SchoolSurveyResultsResource,
  type SchoolSurveysOperations,
} from "@vektorprogrammet/domain";
import {
  DepartmentId,
  MembershipId,
  OrganizationAuthorityInstantSchema,
  PersonId,
  TeamId,
  type OrganizationPersonAuthority,
} from "@vektorprogrammet/domain/organization";
import {
  Identity,
  IdentityActor,
  IdentitySessionNotFound,
  type IdentityOperations,
} from "@vektorprogrammet/domain/identity";
import { Schema, DateTime, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { makeSchoolSurveysTestHttp } from "../test/native-http.js";

const personId = PersonId.make("school-surveys-http-person");

const departmentId = DepartmentId.make("school-surveys-http-department");

const semesterId = SemesterId.make("school-surveys-http-semester");

const observedAt = "2032-04-01T12:00:00.000Z";

const authorizationInstant = OrganizationAuthorityInstantSchema.make(observedAt);

const schoolSurveyId = SurveyId.make("survey_http_results");

const schoolSurveyQuestionId = SurveyQuestionId.make("survey_http_results_q_0");

const sessionRequest = (url: string, init: RequestInit = {}): Request => {
  const headers = new Headers(init.headers);
  headers.set("cookie", "better-auth.session_token=school-surveys-test-session");

  return new Request(url, { ...init, headers });
};

const authority = (
  overrides: Partial<OrganizationPersonAuthority> = {},
): OrganizationPersonAuthority => ({
  personId,
  evaluatedAt: authorizationInstant,
  globalAdministrator: "Absent",
  memberships: [
    {
      membershipId: MembershipId.make("school-surveys-http-membership"),
      teamId: TeamId.make("school-surveys-http-team"),
      departmentId,
      active: true,
      teamLeader: true,
    },
  ],
  ...overrides,
});

const adminSurvey = (
  overrides: Partial<SchoolSurveyAdminResource> = {},
): SchoolSurveyAdminResource => ({
  surveyId: schoolSurveyId,
  departmentId,
  semesterId,
  semesterLabel: "Spring 2032",
  title: "School survey",
  completionText: "Thank you.",
  resultsVisibility: "DepartmentManagers" as const,
  state: "Open" as const,
  revision: 0,
  createdAt: observedAt,
  createdByPersonId: personId,
  closedAt: null,
  closedByPersonId: null,
  responseCount: 1,
  questions: [
    {
      kind: "Text" as const,
      questionId: schoolSurveyQuestionId,
      label: "What worked?",
      help: null,
      required: true,
    },
  ],
  ...overrides,
});

const results = (survey = adminSurvey()): SchoolSurveyResultsResource => ({
  survey,
  responseCount: 1,
  responses: [
    {
      school: { schoolId: SchoolId.make(1), name: "Survey School" },
      submittedAt: observedAt,
      answers: [
        {
          kind: "Text" as const,
          questionId: schoolSurveyQuestionId,
          value: "Everything",
        },
      ],
    },
  ],
});

const identity = Identity.of({
  signIn: () => Promise.reject(new Error("unexpected sign-in")),
  resolveSession: async (cookieHeader: string | undefined) => {
    if (cookieHeader?.includes("school-surveys-test-session")) {
      return new IdentityActor({
        personId,
        sessionId: "school-surveys-test-session",
        expiresAt: DateTime.makeUnsafe(new Date("2032-04-02T12:00:00.000Z")),
      });
    }

    throw new IdentitySessionNotFound();
  },
  readCurrentSession: () => Promise.reject(new Error("unexpected session read")),
  listSessions: () => Promise.reject(new Error("unexpected session list")),
  revokeCurrentSession: () => Promise.reject(new Error("unexpected session mutation")),
  revokeSession: () => Promise.reject(new Error("unexpected session mutation")),
  revokeOtherSessions: () => Promise.reject(new Error("unexpected session mutation")),
  revokeAllSessions: () => Promise.reject(new Error("unexpected session mutation")),
  recordSecurityEvent: () => Promise.reject(new Error("unexpected identity audit")),
  signOut: async () => ({ setCookies: [] }),
} satisfies IdentityOperations);

const nativeProblem = (code: string, title: string, status: number, detail: string) => ({
  type: `urn:vektorprogrammet:problem:v0.2:${code}`,
  title,
  status,
  detail,
  code,
});

const makeDatabase = (projection: OrganizationPersonAuthority) =>
  backendDatabase(
    Database.use((sql) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO person_profiles (person_id,first_name,last_name,revision) VALUES (${projection.personId},'Survey','Person',0)`;

        if (projection.globalAdministrator !== "Absent")
          yield* sql`INSERT INTO organization_global_administrator_grants (grant_id,person_id,start_at,end_at) VALUES ('survey-admin',${projection.personId},'2000-01-01T00:00:00Z',${projection.globalAdministrator === "Active" ? null : "2001-01-01T00:00:00Z"}::timestamptz)`;

        for (const membership of projection.memberships) {
          yield* sql`INSERT INTO organization_departments (department_id,name,short_name,email,city) VALUES (${membership.departmentId},'Survey department','Survey','survey@example.invalid','Oslo') ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO organization_teams (team_id,department_id,name) VALUES (${membership.teamId},${membership.departmentId},'Survey team') ON CONFLICT DO NOTHING`;
          yield* sql`INSERT INTO organization_memberships (membership_id,person_id,team_id,start_at,end_at,is_team_leader) VALUES (${membership.membershipId},${projection.personId},${membership.teamId},'2000-01-01T00:00:00Z',${membership.active ? null : "2001-01-01T00:00:00Z"}::timestamptz,${membership.teamLeader})`;
        }
      }),
    ),
  );

const makeServices = (
  projection: OrganizationPersonAuthority,
  surveyService: Partial<SchoolSurveysOperations>,
) => {
  const defaults = {
    readForm: () => Effect.die("unexpected anonymous form read"),
    prepareResponse: () => Effect.die("unexpected anonymous response preparation"),
    persistResponse: () => Effect.die("unexpected anonymous response persistence"),
    readAdminCatalog: () => Effect.die("unexpected administration catalog read"),
    readAdminSurvey: () => Effect.die("unexpected administration survey read"),
    listAdminSurveys: () => Effect.die("unexpected administration survey list"),
    createAdminSurvey: () => Effect.die("unexpected administration survey create"),
    closeAdminSurvey: () => Effect.die("unexpected administration survey close"),
    readAdminResults: () => Effect.die("unexpected administration results read"),
  };

  const identitySnapshot = {
    resolveSession: (cookieHeader: string | undefined) =>
      cookieHeader?.includes("school-surveys-test-session")
        ? Effect.succeed(
            new IdentityActor({
              personId,
              sessionId: "school-surveys-test-session",
              expiresAt: DateTime.makeUnsafe(new Date("2032-04-02T12:00:00.000Z")),
            }),
          )
        : Effect.fail(new IdentitySessionNotFound()),
  };

  const oauthCredentialAuthority = OAuthCredentialAuthority.of({
    resolve: () => Promise.reject(new Error("unexpected OAuth credential resolution")),
    resolveInTransaction: () => Effect.die("unexpected OAuth credential resolution"),
  });

  return Layer.mergeAll(
    makeDatabase(projection).layer,
    Layer.succeed(SchoolSurveys, SchoolSurveys.of({ ...defaults, ...surveyService })),
    Layer.succeed(Identity, identity),
    Layer.mock(IdentitySnapshot, identitySnapshot),
    Layer.succeed(OAuthCredentialAuthority, oauthCredentialAuthority),
  );
};

describe("School surveys native HTTP adapter", () => {
  it("returns the authorized result projection and its pure CSV representation", async () => {
    const survey = adminSurvey();
    const result = results(survey);
    let catalogAuthorities = 0;
    let resultReads = 0;

    const api = makeSchoolSurveysTestHttp(
      makeServices(authority(), {
        readAdminCatalog: () => {
          catalogAuthorities += 1;

          return Effect.succeed({
            departments: [{ departmentId, name: "Survey department" }],
            semesters: [
              {
                semesterId,
                startAt: "2032-01-01T00:00:00.000Z",
                endAt: "2032-06-30T23:59:59.000Z",
              },
            ],
          });
        },
        readAdminSurvey: () => Effect.succeed(survey),
        listAdminSurveys: () => Effect.succeed({ departmentId, semesterId, surveys: [survey] }),
        readAdminResults: () => {
          resultReads += 1;

          return Effect.succeed(result);
        },
      }),
    );

    const catalogResponse = await api.fetch(
      sessionRequest("http://backend.test/api/surveys/admin/catalog"),
    );

    expect(catalogResponse.status).toBe(200);
    expect(catalogResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(catalogAuthorities).toBe(1);

    const listResponse = await api.fetch(
      sessionRequest(
        `http://backend.test/api/surveys/admin?departmentId=${departmentId}&semesterId=${semesterId}`,
      ),
    );

    expect({ status: listResponse.status, body: await listResponse.json() }).toEqual({
      status: 200,
      body: { departmentId, semesterId, surveys: [survey] },
    });

    const resultResponse = await api.fetch(
      sessionRequest(`http://backend.test/api/surveys/admin/${schoolSurveyId}/results`),
    );

    expect({ status: resultResponse.status, body: await resultResponse.json() }).toEqual({
      status: 200,
      body: result,
    });

    const exportResponse = await api.fetch(
      sessionRequest(`http://backend.test/api/surveys/admin/${schoolSurveyId}/results.csv`),
    );

    expect({
      status: exportResponse.status,
      contentType: exportResponse.headers.get("content-type"),
      contentDisposition: exportResponse.headers.get("content-disposition"),
      cacheControl: exportResponse.headers.get("cache-control"),
      body: await exportResponse.text(),
    }).toEqual({
      status: 200,
      contentType: "text/csv; charset=utf-8",
      contentDisposition: 'attachment; filename="school-survey-survey_http_results-results.csv"',
      cacheControl: "private, no-store",
      body: encodeSchoolSurveyResultsCsv(result),
    });
    expect(resultReads).toBe(2);
  });

  it("routes maximum-length and administration-named public survey IDs", async () => {
    const maximumLengthSurveyId = SurveyId.make("s".repeat(128));
    const administrationNamedSurveyId = SurveyId.make("admin");

    const form = (surveyId: SurveyId) => ({
      surveyId,
      departmentId,
      semesterId,
      semesterLabel: "Spring 2032",
      title: "School survey",
      schools: [{ schoolId: SchoolId.make(1), name: "Survey School" }],
      questions: adminSurvey().questions,
    });

    const api = makeSchoolSurveysTestHttp(
      makeServices(authority(), {
        readForm: (surveyId: SurveyId) => Effect.succeed(form(surveyId)),
      }),
    );

    for (const surveyId of [maximumLengthSurveyId, administrationNamedSurveyId]) {
      const response = await api.fetch(
        new Request(`http://backend.test/api/surveys/public/${surveyId}`),
      );

      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 200,
        body: form(surveyId),
      });
    }
  });

  it("uses receipt-derived commands, generated survey IDs, and revisioned close commands", async () => {
    const createdCommands: Array<CreateSchoolSurveyCommand> = [];
    const closedCommands: Array<CloseSchoolSurveyCommand> = [];
    const survey = adminSurvey({ responseCount: 0 });

    const api = makeSchoolSurveysTestHttp(
      makeServices(authority(), {
        readAdminSurvey: () => Effect.succeed(survey),
        createAdminSurvey: (command: CreateSchoolSurveyCommand) => {
          createdCommands.push(command);

          return Effect.succeed({ ...survey, surveyId: command.surveyId });
        },
        closeAdminSurvey: (command: CloseSchoolSurveyCommand) => {
          closedCommands.push(command);

          return Effect.succeed({
            ...survey,
            state: "Closed",
            revision: 1,
            closedAt: observedAt,
            closedByPersonId: personId,
          });
        },
      }),
    );

    const createPayload = {
      departmentId,
      semesterId,
      title: "School survey",
      completionText: "Thank you.",
      resultsVisibility: "DepartmentManagers",
      questions: [{ kind: "Text", label: "What worked?", help: null, required: true }],
    };

    const createResponse = await api.fetch(
      sessionRequest("http://backend.test/api/surveys/admin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "AAAAAAAAAAAAAAAAAAAAAA",
          origin: "http://127.0.0.1:5174",
        },
        body: JSON.stringify(createPayload),
      }),
    );

    expect(createResponse.status).toBe(201);
    expect(createResponse.headers.get("location")).toMatch(
      /^\/api\/surveys\/public\/survey_[0-9a-f-]+$/u,
    );
    expect(createdCommands).toHaveLength(1);
    expect(String(createdCommands[0]?.commandId)).toMatch(/^httpv2_[A-Za-z0-9_-]{43}$/u);
    expect(String(createdCommands[0]?.surveyId)).toMatch(/^survey_[0-9a-f-]{36}$/u);
    expect(createdCommands[0]?.actorPersonId).toBe(personId);

    const closeResponse = await api.fetch(
      sessionRequest(`http://backend.test/api/surveys/admin/${schoolSurveyId}/close`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "BBBBBBBBBBBBBBBBBBBBBB",
          origin: "http://127.0.0.1:5174",
        },
        body: JSON.stringify({ expectedRevision: 0 }),
      }),
    );

    expect(closeResponse.status).toBe(200);
    expect(closedCommands).toHaveLength(1);
    expect(closedCommands[0]?.surveyId).toBe(schoolSurveyId);
    expect(closedCommands[0]?.request).toEqual({ expectedRevision: 0 });
  });

  it("conceals confidential aggregates from managers but exposes them to global administrators", async () => {
    let resultReads = 0;
    const confidentialSurvey = adminSurvey({ resultsVisibility: "GlobalAdministrators" });

    const closedConfidentialSurvey = {
      ...confidentialSurvey,
      state: "Closed" as const,
      revision: 1,
      closedAt: observedAt,
      closedByPersonId: personId,
    };

    const list = {
      departmentId,
      semesterId,
      surveys: [confidentialSurvey],
    };

    const managerApi = makeSchoolSurveysTestHttp(
      makeServices(authority(), {
        readAdminSurvey: () => Effect.succeed(confidentialSurvey),
        listAdminSurveys: () => Effect.succeed(list),
        closeAdminSurvey: () => Effect.succeed(closedConfidentialSurvey),
        readAdminResults: () => {
          resultReads += 1;

          return Effect.die("confidential results must not be read");
        },
      }),
    );

    const listResponse = await managerApi.fetch(
      sessionRequest(
        `http://backend.test/api/surveys/admin?departmentId=${departmentId}&semesterId=${semesterId}`,
      ),
    );

    const closeResponse = await managerApi.fetch(
      sessionRequest(`http://backend.test/api/surveys/admin/${schoolSurveyId}/close`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "CCCCCCCCCCCCCCCCCCCCCC",
          origin: "http://127.0.0.1:5174",
        },
        body: JSON.stringify({ expectedRevision: 0 }),
      }),
    );

    const resultsResponse = await managerApi.fetch(
      sessionRequest(`http://backend.test/api/surveys/admin/${schoolSurveyId}/results`),
    );

    const listBody = Schema.decodeUnknownSync(SchoolSurveyAdminListResource)(
      await listResponse.json(),
    );

    const closeBody = Schema.decodeUnknownSync(SchoolSurveyAdminResource)(
      await closeResponse.json(),
    );

    expect({
      list: listBody.surveys[0]?.responseCount,
      close: closeBody.responseCount,
    }).toEqual({ list: null, close: null });
    expect({ status: resultsResponse.status, body: await resultsResponse.json() }).toEqual({
      status: 404,
      body: nativeProblem(
        "resource.not-found",
        "Resource not found",
        404,
        "The requested resource was not found.",
      ),
    });
    expect(resultReads).toBe(0);

    const globalApi = makeSchoolSurveysTestHttp(
      makeServices(authority({ globalAdministrator: "Active", memberships: [] }), {
        listAdminSurveys: () => Effect.succeed(list),
      }),
    );

    const globalListResponse = await globalApi.fetch(
      sessionRequest(
        `http://backend.test/api/surveys/admin?departmentId=${departmentId}&semesterId=${semesterId}`,
      ),
    );

    const globalListBody = Schema.decodeUnknownSync(SchoolSurveyAdminListResource)(
      await globalListResponse.json(),
    );

    expect(globalListBody.surveys[0]?.responseCount).toBe(1);
  });
  it("denies ordinary, inactive, and out-of-department survey management before domain reads", async () => {
    let catalogReads = 0;
    let listReads = 0;

    const catalogService = {
      readAdminCatalog: () => {
        catalogReads += 1;

        return Effect.die("unauthorized catalog reads must not reach the domain");
      },
    };

    const ordinary = makeSchoolSurveysTestHttp(
      makeServices(
        authority({ memberships: [{ ...authority().memberships[0]!, teamLeader: false }] }),
        {
          ...catalogService,
        },
      ),
    );

    const inactive = makeSchoolSurveysTestHttp(
      makeServices(authority({ memberships: [], globalAdministrator: "Inactive" }), {
        ...catalogService,
      }),
    );

    const otherDepartmentId = DepartmentId.make("school-surveys-http-other-department");

    const wrongDepartment = makeSchoolSurveysTestHttp(
      makeServices(authority(), {
        listAdminSurveys: () => {
          listReads += 1;

          return Effect.die("out-of-department survey lists must not reach the domain");
        },
      }),
    );

    let globalListReads = 0;

    const globalAdministrator = makeSchoolSurveysTestHttp(
      makeServices(authority({ memberships: [], globalAdministrator: "Active" }), {
        listAdminSurveys: () => {
          globalListReads += 1;

          return Effect.succeed({ departmentId: otherDepartmentId, semesterId, surveys: [] });
        },
      }),
    );

    const [
      ordinaryResponse,
      inactiveResponse,
      wrongDepartmentResponse,
      globalAdministratorResponse,
    ] = await Promise.all([
      ordinary.fetch(sessionRequest("http://backend.test/api/surveys/admin/catalog")),
      inactive.fetch(sessionRequest("http://backend.test/api/surveys/admin/catalog")),
      wrongDepartment.fetch(
        sessionRequest(
          `http://backend.test/api/surveys/admin?departmentId=${otherDepartmentId}&semesterId=${semesterId}`,
        ),
      ),
      globalAdministrator.fetch(
        sessionRequest(
          `http://backend.test/api/surveys/admin?departmentId=${otherDepartmentId}&semesterId=${semesterId}`,
        ),
      ),
    ]);

    expect([
      ordinaryResponse.status,
      inactiveResponse.status,
      wrongDepartmentResponse.status,
      globalAdministratorResponse.status,
    ]).toEqual([403, 403, 403, 200]);
    expect({ catalogReads, listReads, globalListReads }).toEqual({
      catalogReads: 0,
      listReads: 0,
      globalListReads: 1,
    });
  });

  it("replays an accepted response after closure in any answer order but rejects a duplicate-selection body", async () => {
    let open = true;
    let prepareCalls = 0;
    let persistCalls = 0;

    const api = makeSchoolSurveysTestHttp(
      makeServices(authority(), {
        prepareResponse: ({ request }) => {
          prepareCalls += 1;

          return open
            ? Effect.succeed({
                surveyId: schoolSurveyId,
                departmentId,
                completionText: "Thank you.",
                schoolId: request.schoolId,
                answers: request.answers,
              })
            : Effect.fail(new SchoolSurveyNotFound({ surveyId: String(schoolSurveyId) }));
        },
        persistResponse: ({ responseId, prepared }) => {
          persistCalls += 1;

          return Effect.succeed({
            responseId,
            submittedAt: observedAt,
            completionText: prepared.completionText,
          });
        },
      }),
    );

    const textAnswer = {
      kind: "Text",
      questionId: SurveyQuestionId.make("survey_http_results_q_1"),
      value: "Everything",
    };

    const checkAnswer = (values: ReadonlyArray<string>) => ({
      kind: "Check",
      questionId: schoolSurveyQuestionId,
      values,
    });

    const request = (answers: ReadonlyArray<Schema.Json>) =>
      new Request(`http://backend.test/api/surveys/public/${schoolSurveyId}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "REPLAYAFTERCLOSURE0001",
        },
        body: JSON.stringify({ schoolId: 1, answers }),
      });

    const accepted = await api.fetch(request([checkAnswer(["Second", "First"]), textAnswer]));
    const acceptedBody = await accepted.json();
    open = false;
    const replayed = await api.fetch(request([checkAnswer(["Second", "First"]), textAnswer]));
    const reordered = await api.fetch(request([textAnswer, checkAnswer(["First", "Second"])]));

    expect(replayed.status).toBe(201);
    expect(await replayed.json()).toEqual(acceptedBody);
    expect(reordered.status).toBe(201);
    expect(await reordered.json()).toEqual(acceptedBody);
    expect({ prepareCalls, persistCalls }).toEqual({ prepareCalls: 1, persistCalls: 1 });

    const duplicateSelection = await api.fetch(
      request([checkAnswer(["First", "First", "Second"]), textAnswer]),
    );

    const duplicateSelectionBody = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(
      await duplicateSelection.json(),
    );

    expect({
      status: duplicateSelection.status,
      code: duplicateSelectionBody.code,
    }).toEqual({
      status: 409,
      code: "idempotency.digest-conflict",
    });
  });

  it("keeps a closed anonymous survey concealed and avoids response persistence", async () => {
    let persistCalls = 0;

    const api = makeSchoolSurveysTestHttp(
      makeServices(authority(), {
        readForm: () => Effect.fail(new SchoolSurveyNotFound({ surveyId: String(schoolSurveyId) })),
        prepareResponse: () =>
          Effect.fail(new SchoolSurveyNotFound({ surveyId: String(schoolSurveyId) })),
        persistResponse: () => {
          persistCalls += 1;

          return Effect.die("closed survey responses must not persist");
        },
      }),
    );

    const formResponse = await api.fetch(
      new Request(`http://backend.test/api/surveys/public/${schoolSurveyId}`),
    );

    expect(formResponse.status).toBe(404);

    const submitResponse = await api.fetch(
      new Request(`http://backend.test/api/surveys/public/${schoolSurveyId}/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "CCCCCCCCCCCCCCCCCCCCCC",
        },
        body: JSON.stringify({
          schoolId: 1,
          answers: [{ kind: "Text", questionId: schoolSurveyQuestionId, value: "Everything" }],
        }),
      }),
    );

    expect({ status: submitResponse.status, body: await submitResponse.json() }).toEqual({
      status: 404,
      body: nativeProblem(
        "resource.not-found",
        "Resource not found",
        404,
        "The requested resource was not found.",
      ),
    });
    expect(persistCalls).toBe(0);
  });
});
