import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  AdmissionPeriodManagementItem,
  AdmissionsSubmitApplicationProblem,
  makeNativeValidationError,
  type NativeValidationError,
  PublicApplicationConfirmationSchema,
  ReadApplicationCatalogEndpoint,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { type HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

const REAL_PUBLIC_APPLICATION_E2E = process.env.REAL_PUBLIC_APPLICATION_E2E === "1";

/**
 * The loopback origin keeps the page a secure context, where the form's
 * crypto.randomUUID exists; each request carries the local homepage Host instead.
 */
const HOMEPAGE_ORIGIN = process.env.HOMEPAGE_ORIGIN ?? "http://127.0.0.1:8787";

const LOCAL_HOMEPAGE_HOST = "p000.vektor.phibkro.org";

const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8792";

const DEPARTMENT_ID = "department-trondheim";

const FIELD_OF_STUDY_ID = "field-mathematics";

const INACTIVE_FIELD_OF_STUDY_ID = "field-inactive";

const FOREIGN_FIELD_OF_STUDY_ID = "field-foreign";

const APPLICANT_FIRST_NAME = "Applicant Canary";

const APPLICANT_LAST_NAME = "Private Surname";

const APPLICANT_EMAIL = "applicant-canary-0039@example.invalid";

const APPLICANT_PHONE = "+47 900 00 039";

const privateCanaries = [
  APPLICANT_FIRST_NAME,
  APPLICANT_LAST_NAME,
  APPLICANT_EMAIL,
  APPLICANT_PHONE,
] as const;

/** The body schema of each response that one endpoint declares. */
type ResponseBody<Response> =
  Response extends HttpApiSchema.WithHeaders<infer Body, infer _Headers> ? Body : never;

/** The 200 body that the application options endpoint declares; its 304 has none. */
const catalogSchema = (() => {
  for (const response of ReadApplicationCatalogEndpoint.success) {
    if (HttpApiSchema.isWithHeaders(response) && !HttpApiSchema.isNoContent(response.schema.ast)) {
      // SAFETY: the endpoint's runtime set holds exactly the responses its type declares.
      return response.schema as ResponseBody<
        HttpApiEndpoint.Success<typeof ReadApplicationCatalogEndpoint>
      >;
    }
  }

  throw new Error("The application options endpoint declares no body");
})();

const decodeStrict = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`Missing ${name}`);

  return value;
}

type ApplicationInput = {
  readonly departmentId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email: string;
  readonly gender: number;
  readonly fieldOfStudyId: string;
  readonly yearOfStudy: number;
};

function applicationInput(overrides: Partial<ApplicationInput> = {}): ApplicationInput {
  return {
    departmentId: DEPARTMENT_ID,
    firstName: APPLICANT_FIRST_NAME,
    lastName: APPLICANT_LAST_NAME,
    phone: APPLICANT_PHONE,
    email: APPLICANT_EMAIL,
    gender: 0,
    fieldOfStudyId: FIELD_OF_STUDY_ID,
    yearOfStudy: 3,
    ...overrides,
  };
}

/** A submitted body; the excess-property law adds a member the contract does not declare. */
type SubmittedApplication = ApplicationInput & { readonly applicantId?: string };

/** Submits one application under its own Idempotency-Key unless a replay names one. */
function submit(
  request: APIRequestContext,
  data: SubmittedApplication,
  idempotencyKey: string = randomUUID(),
): Promise<APIResponse> {
  return request.post(`${BACKEND_ORIGIN}/api/applications`, {
    headers: { "idempotency-key": idempotencyKey },
    data,
  });
}

/** Decodes one rejection through the submit endpoint's closed Problem Details union. */
async function rejection(response: APIResponse, status: number) {
  expect(response.status()).toBe(status);
  expect(response.headers()["content-type"]).toBe("application/problem+json");

  return decodeStrict(AdmissionsSubmitApplicationProblem)(await response.json());
}

async function expectProblem(
  response: APIResponse,
  status: number,
  code: string,
): Promise<{ readonly status: number; readonly code: string }> {
  const problem = await rejection(response, status);
  expect(problem.code).toBe(code);

  return { status, code: problem.code };
}

/** A validation failure names exactly the rejected members, by pointer and never by value. */
async function expectValidation(
  response: APIResponse,
  errors: ReadonlyArray<NativeValidationError>,
): Promise<{ readonly status: number; readonly code: string; readonly pointers: string[] }> {
  const problem = await rejection(response, 422);

  expect(problem).toMatchObject({
    code: "validation.failed",
    validation: { errors, truncated: false },
  });

  return { status: 422, code: problem.code, pointers: errors.map((error) => error.pointer) };
}

/** Asserts that the application section has no serious or critical axe violation. */
async function expectNoSeriousViolations(page: Page): Promise<number> {
  const result = await new AxeBuilder({ page }).include('section[id="sok"]').analyze();

  // Rule IDs and selectors name each violation without the values that fields hold.
  const serious = result.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => String(node.target)),
    }));

  expect(serious).toEqual([]);

  return serious.length;
}

async function fillApplicationForm(page: Page, input: ApplicationInput): Promise<void> {
  await page.getByLabel("Avdeling").selectOption(input.departmentId);
  await page.getByLabel("Studieretning").selectOption(input.fieldOfStudyId);
  await page.getByLabel("Studieår").selectOption(String(input.yearOfStudy));
  await page.getByLabel("Fornavn").fill(input.firstName);
  await page.getByLabel("Etternavn").fill(input.lastName);
  await page.getByLabel("E-post").fill(input.email);
  await page.getByLabel("Telefonnummer").fill(input.phone);
  await page.getByLabel("Kjønn").selectOption(String(input.gender));
}

async function catalog(request: APIRequestContext) {
  const response = await request.get(`${BACKEND_ORIGIN}/api/application-options`);
  expect(response.status()).toBe(200);

  const decoded = decodeStrict(catalogSchema)(await response.json());

  if (decoded === undefined) throw new Error("The application options response has no body");

  return decoded;
}

async function confirmation(request: APIRequestContext, applicationId: string) {
  const response = await request.get(`${BACKEND_ORIGIN}/api/applications/${applicationId}`);
  expect(response.status()).toBe(200);

  return decodeStrict(PublicApplicationConfirmationSchema)(await response.json());
}

test.use({ baseURL: HOMEPAGE_ORIGIN });

test.describe("Public applicant admission", () => {
  test.skip(!REAL_PUBLIC_APPLICATION_E2E, "run through the disposable PostgreSQL homepage runner");

  test("submits through the homepage and proves public rejection laws", async ({
    page,
    request,
  }) => {
    const evidencePath = requiredEnvironment("PUBLIC_APPLICATION_E2E_EVIDENCE_PATH");
    const admissionPeriodId = requiredEnvironment("PUBLIC_APPLICATION_E2E_PERIOD_ID");
    const admissionPeriodETag = requiredEnvironment("PUBLIC_APPLICATION_E2E_PERIOD_ETAG");

    const admissionPeriodRevision = Number(
      requiredEnvironment("PUBLIC_APPLICATION_E2E_PERIOD_REVISION"),
    );

    const openEnd = requiredEnvironment("PUBLIC_APPLICATION_E2E_OPEN_END");
    const closedEnd = requiredEnvironment("PUBLIC_APPLICATION_E2E_CLOSED_END");
    const leaderCookie = requiredEnvironment("PUBLIC_APPLICATION_E2E_LEADER_COOKIE");
    const staffOrigin = requiredEnvironment("PUBLIC_APPLICATION_E2E_STAFF_ORIGIN");

    const rateLimitAttempts = Number(
      requiredEnvironment("PUBLIC_APPLICATION_E2E_RATE_LIMIT_ATTEMPTS"),
    );

    // React Router aborts an action whose Origin names another host than its URL, so a
    // request that carries an Origin names the local homepage host there as well.
    await page.route(`${HOMEPAGE_ORIGIN}/**`, async (route) => {
      const headers = Object.fromEntries(
        Object.entries(route.request().headers()).map(([name, value]) => [
          name,
          name === "origin" ? `http://${LOCAL_HOMEPAGE_HOST}` : value,
        ]),
      );

      headers.host = LOCAL_HOMEPAGE_HOST;

      const response = await route.fetch({ headers });

      await route.fulfill({ response });
    });

    let submittedCommandId = "";
    let submittedFormFields: string[] = [];
    page.on("request", (browserRequest) => {
      const url = new URL(browserRequest.url());

      if (
        submittedCommandId !== "" ||
        browserRequest.method() !== "POST" ||
        url.origin !== HOMEPAGE_ORIGIN ||
        !url.pathname.includes("assistenter")
      ) {
        return;
      }

      const body = new URLSearchParams(browserRequest.postData() ?? "");
      submittedCommandId = body.get("commandId") ?? "";
      submittedFormFields = [...body.keys()].sort();
    });

    const initialCatalog = await catalog(request);
    expect(initialCatalog.departments).toEqual([
      {
        departmentId: DEPARTMENT_ID,
        name: "Trondheim",
        closesAt: openEnd,
        fieldsOfStudy: [
          {
            fieldOfStudyId: FIELD_OF_STUDY_ID,
            name: "Matematikk",
          },
        ],
      },
    ]);

    await page.goto("/assistenter");
    await expect(page.getByRole("heading", { name: "Send inn søknad" })).toBeVisible();
    await expect(page.getByLabel("Avdeling")).toContainText("Trondheim");
    await page.getByLabel("Avdeling").selectOption(DEPARTMENT_ID);
    await expect(page.getByLabel("Studieretning")).toContainText("Matematikk");
    const formAxeViolations = await expectNoSeriousViolations(page);

    const acceptedInput = applicationInput();
    await fillApplicationForm(page, acceptedInput);
    await page.getByRole("button", { name: "Send søknad" }).click();
    await expect(page.getByRole("heading", { name: "Søknaden er mottatt" })).toBeVisible();
    expect(submittedCommandId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(submittedFormFields).toEqual(
      [
        "commandId",
        "departmentId",
        "firstName",
        "lastName",
        "phone",
        "email",
        "gender",
        "fieldOfStudyId",
        "yearOfStudy",
      ].sort(),
    );
    const applicationId = await page.getByTestId("application-id").textContent();
    expect(applicationId).toBeTruthy();

    if (!applicationId) throw new Error("Opaque application ID was absent");
    const confirmationAxeViolations = await expectNoSeriousViolations(page);
    const confirmationPage = await page.locator("body").innerText();

    for (const canary of privateCanaries) {
      expect(confirmationPage).not.toContain(canary);
    }

    // The homepage submitted the form's command ID as the Idempotency-Key, so the same
    // key and payload replay the committed confirmation.
    const replayResponse = await submit(request, acceptedInput, submittedCommandId);
    expect(replayResponse.status()).toBe(201);
    const replay = decodeStrict(PublicApplicationConfirmationSchema)(await replayResponse.json());
    expect(replay.applicationId).toBe(applicationId);

    const initialConfirmation = await confirmation(request, applicationId);
    expect(initialConfirmation.applicationId).toBe(applicationId);

    const replayConflict = await expectProblem(
      await submit(request, applicationInput({ phone: "+47 911 11 111" }), submittedCommandId),
      409,
      "idempotency.digest-conflict",
    );

    await page.reload();

    const duplicateInput = applicationInput({
      firstName: "Changed Applicant",
      lastName: "Changed Surname",
      phone: "+47 922 22 222",
      email: APPLICANT_EMAIL.toUpperCase(),
    });

    await fillApplicationForm(page, duplicateInput);
    await page.getByRole("button", { name: "Send søknad" }).click();
    const duplicateAlert = page.locator('[data-error-tag="application.duplicate"]');
    await expect(duplicateAlert).toBeVisible();
    await expect(page.getByLabel("Fornavn")).toHaveValue(duplicateInput.firstName);
    await expect(page.getByLabel("Etternavn")).toHaveValue(duplicateInput.lastName);
    await expect(page.getByLabel("E-post")).toHaveValue(duplicateInput.email);
    await expect(page.getByLabel("Telefonnummer")).toHaveValue(duplicateInput.phone);
    const duplicateCommandId = await page.locator('input[name="commandId"]').inputValue();
    expect(duplicateCommandId).not.toBe(submittedCommandId);
    const errorAxeViolations = await expectNoSeriousViolations(page);

    const malformedInputs = [
      [applicationInput({ firstName: "" }), "/firstName"],
      [applicationInput({ email: "not-an-email" }), "/email"],
      [applicationInput({ phone: "" }), "/phone"],
      [applicationInput({ gender: 2 }), "/gender"],
      [applicationInput({ yearOfStudy: 6 }), "/yearOfStudy"],
      [applicationInput({ departmentId: "" }), "/departmentId"],
      [applicationInput({ fieldOfStudyId: "" }), "/fieldOfStudyId"],
    ] as const;

    const validation = [];

    for (const [data, pointer] of malformedInputs) {
      validation.push(
        await expectValidation(await submit(request, data), [
          makeNativeValidationError(pointer, "invalid"),
        ]),
      );
    }

    const excess = await expectValidation(
      await submit(request, {
        ...applicationInput(),
        applicantId: "browser-must-not-select-identity",
      }),
      [makeNativeValidationError("/applicantId", "unknown")],
    );

    const malformedJson = await expectProblem(
      await request.fetch(`${BACKEND_ORIGIN}/api/applications`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
        // Playwright serializes a string that does not parse as JSON; bytes go out unchanged.
        data: Buffer.from("{"),
      }),
      400,
      "request.malformed",
    );

    const wrongContentType = await expectProblem(
      await request.fetch(`${BACKEND_ORIGIN}/api/applications`, {
        method: "POST",
        headers: { "content-type": "text/plain", "idempotency-key": randomUUID() },
        data: JSON.stringify(applicationInput()),
      }),
      415,
      "media-type.unsupported",
    );

    const bodyLimit = await expectProblem(
      await submit(request, applicationInput({ firstName: "x".repeat(131_072) })),
      413,
      "request.too-large",
    );

    // The frozen unions have no department problem, so an unknown department is invalid input.
    const unknownDepartment = await expectValidation(
      await submit(request, applicationInput({ departmentId: "department-unknown" })),
      [makeNativeValidationError("/departmentId", "invalid")],
    );

    const unknownField = await expectProblem(
      await submit(request, applicationInput({ fieldOfStudyId: "field-unknown" })),
      422,
      "application.invalid-field-of-study",
    );

    const inactiveField = await expectProblem(
      await submit(request, applicationInput({ fieldOfStudyId: INACTIVE_FIELD_OF_STUDY_ID })),
      422,
      "application.invalid-field-of-study",
    );

    const crossDepartmentField = await expectProblem(
      await submit(request, applicationInput({ fieldOfStudyId: FOREIGN_FIELD_OF_STUDY_ID })),
      422,
      "application.invalid-field-of-study",
    );

    const concurrentResponses = await Promise.all([
      submit(request, applicationInput({ email: "concurrent-applicant-0039@example.invalid" })),
      submit(request, applicationInput({ email: "CONCURRENT-APPLICANT-0039@EXAMPLE.INVALID" })),
    ]);

    const concurrentAccepted = concurrentResponses.filter((response) => response.status() === 201);
    const concurrentRejected = concurrentResponses.filter((response) => response.status() !== 201);
    expect(concurrentAccepted).toHaveLength(1);
    expect(concurrentRejected).toHaveLength(1);

    const concurrentObservation = decodeStrict(PublicApplicationConfirmationSchema)(
      await concurrentAccepted[0]!.json(),
    );

    const concurrentDuplicate = await expectProblem(
      concurrentRejected[0]!,
      409,
      "application.duplicate",
    );

    const closeResponse = await request.patch(
      `${BACKEND_ORIGIN}/api/admission-periods/${admissionPeriodId}`,
      {
        headers: {
          cookie: leaderCookie,
          origin: staffOrigin,
          "content-type": "application/merge-patch+json",
          "if-match": admissionPeriodETag,
          "idempotency-key": randomUUID(),
        },
        data: JSON.stringify({ endAt: closedEnd }),
      },
    );

    expect(closeResponse.status()).toBe(200);
    const closedPeriod = decodeStrict(AdmissionPeriodManagementItem)(await closeResponse.json());
    expect(closedPeriod).toMatchObject({
      id: admissionPeriodId,
      endAt: closedEnd,
      revision: admissionPeriodRevision + 1,
    });

    const confirmationAfterClose = await confirmation(request, applicationId);
    expect(confirmationAfterClose.applicationId).toBe(applicationId);

    const closedApplication = await expectProblem(
      await submit(request, applicationInput({ email: "after-close-0039@example.invalid" })),
      409,
      "application.no-eligible-period",
    );

    expect((await catalog(request)).departments).toEqual([]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ingen opptak er åpne nå" })).toBeVisible();

    let rateLimited:
      | { readonly status: number; readonly code: string; readonly retryAfter: string }
      | undefined;

    for (let index = 0; index < rateLimitAttempts && !rateLimited; index += 1) {
      const response = await submit(
        request,
        applicationInput({ email: `rate-limit-${index}@example.invalid` }),
      );

      if (response.status() === 429) {
        const problem = await expectProblem(response, 429, "rate-limit.exceeded");
        const retryAfter = response.headers()["retry-after"] ?? "";
        expect(retryAfter).toMatch(/^[1-9][0-9]*$/u);
        rateLimited = { ...problem, retryAfter };
      } else {
        await expectProblem(response, 409, "application.no-eligible-period");
      }
    }

    expect(rateLimited?.code).toBe("rate-limit.exceeded");

    const lifecycle = {
      catalog: {
        departmentIds: initialCatalog.departments.map((department) => department.departmentId),
        fieldIds: initialCatalog.departments.flatMap((department) =>
          department.fieldsOfStudy.map((field) => field.fieldOfStudyId),
        ),
      },
      browser: {
        commandId: submittedCommandId,
        submittedFieldNames: submittedFormFields,
        applicationId,
        draftPreservedAfterDuplicate: true,
        axe: {
          formSeriousCritical: formAxeViolations,
          errorSeriousCritical: errorAxeViolations,
          confirmationSeriousCritical: confirmationAxeViolations,
        },
      },
      replay: {
        applicationId: replay.applicationId,
        sameApplicationId: replay.applicationId === applicationId,
      },
      concurrent: {
        acceptedApplicationId: concurrentObservation.applicationId,
        rejected: concurrentDuplicate,
      },
      closing: {
        periodId: admissionPeriodId,
        revision: closedPeriod.revision,
        acceptedApplicationId: applicationId,
        confirmationPreserved: confirmationAfterClose.applicationId === applicationId,
        rejection: closedApplication,
      },
      rejections: {
        duplicate: {
          code: "application.duplicate",
          commandId: duplicateCommandId,
        },
        replayConflict,
        validation,
        excess,
        malformedJson,
        wrongContentType,
        bodyLimit,
        unknownDepartment,
        unknownField,
        inactiveField,
        crossDepartmentField,
        rateLimited,
      },
      privacy: {
        confirmationContainsPrivateCanary: false,
        evidenceContainsPrivateCanary: false,
      },
    };

    const evidence = JSON.stringify(lifecycle);

    for (const canary of [...privateCanaries, leaderCookie]) {
      expect(evidence).not.toContain(canary);
    }

    await writeFile(evidencePath, `${evidence}\n`, "utf8");
  });
});
