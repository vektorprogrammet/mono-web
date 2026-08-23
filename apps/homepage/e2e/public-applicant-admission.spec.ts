import AxeBuilder from "@axe-core/playwright";
import { writeFile } from "node:fs/promises";
import { Schema } from "effect";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

const REAL_PUBLIC_APPLICATION_E2E = process.env.REAL_PUBLIC_APPLICATION_E2E === "1";
const HOMEPAGE_ORIGIN = process.env.HOMEPAGE_ORIGIN ?? "http://127.0.0.1:8787";
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8792";
const LOCAL_HOMEPAGE_HOST = "p000.vektor.phibkro.org";
const DEPARTMENT_ID = "department-trondheim";
const FIELD_OF_STUDY_ID = "field-mathematics";
const INACTIVE_FIELD_OF_STUDY_ID = "field-inactive";
const FOREIGN_FIELD_OF_STUDY_ID = "field-foreign";
const OPEN_START = "2031-09-01T08:00:00.000Z";
const CLOSED_END = "2031-09-10T12:00:00.000Z";
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

const catalogSchema = Schema.Struct({
  departments: Schema.Array(
    Schema.Struct({
      departmentId: Schema.String,
      name: Schema.String,
      closesAt: Schema.String,
      fieldsOfStudy: Schema.Array(
        Schema.Struct({
          fieldOfStudyId: Schema.String,
          name: Schema.String,
        }),
      ),
    }),
  ),
});
const submittedSchema = Schema.Struct({
  _tag: Schema.Literal("Submitted"),
  commandId: Schema.String,
  applicationId: Schema.String,
});
const confirmationSchema = Schema.Struct({
  _tag: Schema.Literal("ApplicationConfirmed"),
  applicationId: Schema.String,
});
const errorSchema = Schema.Struct({
  error: Schema.Struct({ tag: Schema.String }),
});

const decodeStrict = <A>(schema: Schema.ConstraintDecoder<A, never>, value: unknown): A =>
  Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" });

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
type ApplicationInput = {
  readonly commandId: string;
  readonly departmentId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly email: string;
  readonly gender: number;
  readonly fieldOfStudyId: string;
  readonly yearOfStudy: number;
};

function applicationInput(
  commandId: string,
  overrides: Partial<Omit<ApplicationInput, "commandId">> = {},
): ApplicationInput {
  return {
    commandId,
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

async function expectErrorTag(
  response: APIResponse,
  expectedTag: string,
): Promise<{ readonly status: number; readonly tag: string }> {
  expect(response.ok()).toBe(false);
  const decoded = decodeStrict(errorSchema, await response.json());
  expect(decoded.error.tag).toBe(expectedTag);
  return { status: response.status(), tag: decoded.error.tag };
}

async function seriousCriticalViolations(page: Page): Promise<number> {
  const result = await new AxeBuilder({ page }).include('section[id="sok"]').analyze();
  return result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  ).length;
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
  const response = await request.get(`${BACKEND_ORIGIN}/api/applications/catalog`);
  expect(response.ok()).toBe(true);
  return decodeStrict(catalogSchema, await response.json());
}

test.describe("Public applicant admission", () => {
  test.skip(!REAL_PUBLIC_APPLICATION_E2E, "run through the disposable PostgreSQL homepage runner");

  test("submits through the homepage and proves public rejection laws", async ({
    page,
    request,
  }) => {
    const evidencePath = requiredEnvironment("PUBLIC_APPLICATION_E2E_EVIDENCE_PATH");
    const admissionPeriodId = requiredEnvironment("PUBLIC_APPLICATION_E2E_PERIOD_ID");
    const leaderToken = requiredEnvironment("PUBLIC_APPLICATION_E2E_LEADER_TOKEN");
    const rateLimitAttempts = Number(
      requiredEnvironment("PUBLIC_APPLICATION_E2E_RATE_LIMIT_ATTEMPTS"),
    );

    await page.route(`${HOMEPAGE_ORIGIN}/**`, async (route) => {
      const response = await route.fetch({
        headers: {
          ...route.request().headers(),
          host: LOCAL_HOMEPAGE_HOST,
        },
      });
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
    expect(initialCatalog.departments).toHaveLength(1);
    expect(initialCatalog.departments[0]).toEqual({
      departmentId: DEPARTMENT_ID,
      name: "Trondheim",
      closesAt: "2031-10-01T20:00:00.000Z",
      fieldsOfStudy: [
        {
          fieldOfStudyId: FIELD_OF_STUDY_ID,
          name: "Matematikk",
        },
      ],
    });

    await page.goto("/assistenter");
    await expect(page.getByRole("heading", { name: "Send inn søknad" })).toBeVisible();
    await expect(page.getByLabel("Avdeling")).toContainText("Trondheim");
    await page.getByLabel("Avdeling").selectOption(DEPARTMENT_ID);
    await expect(page.getByLabel("Studieretning")).toContainText("Matematikk");
    const formAxeViolations = await seriousCriticalViolations(page);
    expect(formAxeViolations).toBe(0);

    const acceptedInput = applicationInput("browser-replaced-command-id");
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
    const confirmationAxeViolations = await seriousCriticalViolations(page);
    expect(confirmationAxeViolations).toBe(0);
    const confirmationPage = await page.locator("body").innerText();
    for (const canary of privateCanaries) {
      expect(confirmationPage).not.toContain(canary);
    }

    const replayResponse = await request.post(`${BACKEND_ORIGIN}/api/applications`, {
      data: applicationInput(submittedCommandId),
    });
    expect(replayResponse.ok()).toBe(true);
    const replay = decodeStrict(submittedSchema, await replayResponse.json());
    expect(replay).toEqual({
      _tag: "Submitted",
      commandId: submittedCommandId,
      applicationId,
    });

    const confirmationResponse = await request.get(
      `${BACKEND_ORIGIN}/api/applications/${applicationId}/confirmation`,
    );
    expect(confirmationResponse.ok()).toBe(true);
    expect(decodeStrict(confirmationSchema, await confirmationResponse.json())).toEqual({
      _tag: "ApplicationConfirmed",
      applicationId,
    });

    const replayConflict = await expectErrorTag(
      await request.post(`${BACKEND_ORIGIN}/api/applications`, {
        data: applicationInput(submittedCommandId, {
          phone: "+47 911 11 111",
        }),
      }),
      "DuplicatePublicApplicationCommandConflict",
    );

    await page.reload();
    const duplicateInput = applicationInput("browser-duplicate-command", {
      firstName: "Changed Applicant",
      lastName: "Changed Surname",
      phone: "+47 922 22 222",
      email: APPLICANT_EMAIL.toUpperCase(),
    });
    await fillApplicationForm(page, duplicateInput);
    await page.getByRole("button", { name: "Send søknad" }).click();
    const duplicateAlert = page.locator('[data-error-tag="DuplicatePublicApplication"]');
    await expect(duplicateAlert).toBeVisible();
    await expect(page.getByLabel("Fornavn")).toHaveValue(duplicateInput.firstName);
    await expect(page.getByLabel("Etternavn")).toHaveValue(duplicateInput.lastName);
    await expect(page.getByLabel("E-post")).toHaveValue(duplicateInput.email);
    await expect(page.getByLabel("Telefonnummer")).toHaveValue(duplicateInput.phone);
    const duplicateCommandId = await page.locator('input[name="commandId"]').inputValue();
    expect(duplicateCommandId).not.toBe(submittedCommandId);
    const errorAxeViolations = await seriousCriticalViolations(page);
    expect(errorAxeViolations).toBe(0);

    const malformedInputs = [
      applicationInput("invalid-name", { firstName: "" }),
      applicationInput("invalid-email", { email: "not-an-email" }),
      applicationInput("invalid-phone", { phone: "" }),
      applicationInput("invalid-gender", { gender: 2 }),
      applicationInput("invalid-year", { yearOfStudy: 6 }),
      applicationInput("invalid-department-id", { departmentId: "" }),
      applicationInput("invalid-field-id", { fieldOfStudyId: "" }),
    ];
    const validationTags: string[] = [];
    for (const data of malformedInputs) {
      const rejection = await expectErrorTag(
        await request.post(`${BACKEND_ORIGIN}/api/applications`, {
          data,
        }),
        "PublicApplicationDecodeError",
      );
      validationTags.push(rejection.tag);
    }

    const excess = await expectErrorTag(
      await request.post(`${BACKEND_ORIGIN}/api/applications`, {
        data: {
          ...applicationInput("invalid-excess"),
          applicantId: "browser-must-not-select-identity",
        },
      }),
      "PublicApplicationDecodeError",
    );
    const malformedJson = await expectErrorTag(
      await request.fetch(`${BACKEND_ORIGIN}/api/applications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        data: "{",
      }),
      "PublicApplicationDecodeError",
    );
    const wrongContentType = await expectErrorTag(
      await request.fetch(`${BACKEND_ORIGIN}/api/applications`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        data: JSON.stringify(applicationInput("invalid-content-type")),
      }),
      "PublicApplicationDecodeError",
    );
    const bodyLimit = await expectErrorTag(
      await request.post(`${BACKEND_ORIGIN}/api/applications`, {
        data: applicationInput("invalid-body-limit", {
          firstName: "x".repeat(131_072),
        }),
      }),
      "RequestBodyTooLarge",
    );
    const unknownDepartment = await expectErrorTag(
      await request.post(`${BACKEND_ORIGIN}/api/applications`, {
        data: applicationInput("unknown-department", {
          departmentId: "department-unknown",
        }),
      }),
      "DepartmentNotFound",
    );
    const unknownField = await expectErrorTag(
      await request.post(`${BACKEND_ORIGIN}/api/applications`, {
        data: applicationInput("unknown-field", {
          fieldOfStudyId: "field-unknown",
        }),
      }),
      "FieldOfStudyNotFound",
    );
    const inactiveField = await expectErrorTag(
      await request.post(`${BACKEND_ORIGIN}/api/applications`, {
        data: applicationInput("inactive-field", {
          fieldOfStudyId: INACTIVE_FIELD_OF_STUDY_ID,
        }),
      }),
      "FieldOfStudyInactive",
    );
    const crossDepartmentField = await expectErrorTag(
      await request.post(`${BACKEND_ORIGIN}/api/applications`, {
        data: applicationInput("cross-department-field", {
          fieldOfStudyId: FOREIGN_FIELD_OF_STUDY_ID,
        }),
      }),
      "FieldOfStudyDepartmentMismatch",
    );

    const concurrentInputs = [
      applicationInput("concurrent-public-application-a", {
        email: "concurrent-applicant-0039@example.invalid",
      }),
      applicationInput("concurrent-public-application-b", {
        email: "CONCURRENT-APPLICANT-0039@EXAMPLE.INVALID",
      }),
    ] as const;
    const concurrentResponses = await Promise.all(
      concurrentInputs.map((data) => request.post(`${BACKEND_ORIGIN}/api/applications`, { data })),
    );
    const concurrentAccepted = concurrentResponses.filter((response) => response.ok());
    const concurrentRejected = concurrentResponses.filter((response) => !response.ok());
    expect(concurrentAccepted).toHaveLength(1);
    expect(concurrentRejected).toHaveLength(1);
    const concurrentObservation = decodeStrict(submittedSchema, await concurrentAccepted[0].json());
    const concurrentDuplicate = await expectErrorTag(
      concurrentRejected[0],
      "DuplicatePublicApplication",
    );

    const closeResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/admission-periods/${admissionPeriodId}/revise`,
      {
        headers: { authorization: `Bearer ${leaderToken}` },
        data: {
          commandId: "close-public-application-period-0039",
          expectedRevision: 0,
          startAt: OPEN_START,
          endAt: CLOSED_END,
        },
      },
    );
    expect(closeResponse.ok()).toBe(true);

    const confirmationAfterClose = await request.get(
      `${BACKEND_ORIGIN}/api/applications/${applicationId}/confirmation`,
    );
    expect(confirmationAfterClose.ok()).toBe(true);
    expect(decodeStrict(confirmationSchema, await confirmationAfterClose.json())).toMatchObject({
      applicationId,
    });
    const closedApplication = await expectErrorTag(
      await request.post(`${BACKEND_ORIGIN}/api/applications`, {
        data: applicationInput("application-after-close", {
          email: "after-close-0039@example.invalid",
        }),
      }),
      "NoEligibleAdmissionPeriod",
    );
    expect((await catalog(request)).departments).toEqual([]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ingen opptak er åpne nå" })).toBeVisible();

    let rateLimited: { readonly status: number; readonly tag: string } | undefined;
    for (let index = 0; index < rateLimitAttempts && !rateLimited; index += 1) {
      const response = await request.post(`${BACKEND_ORIGIN}/api/applications`, {
        data: applicationInput(`rate-limit-${index}`, {
          email: `rate-limit-${index}@example.invalid`,
        }),
      });
      if (!response.ok()) {
        const decoded = decodeStrict(errorSchema, await response.json());
        if (decoded.error.tag === "PublicApplicationRateLimitExceeded") {
          rateLimited = {
            status: response.status(),
            tag: decoded.error.tag,
          };
        }
      }
    }
    expect(rateLimited?.tag).toBe("PublicApplicationRateLimitExceeded");

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
        commandId: replay.commandId,
        applicationId: replay.applicationId,
        sameApplicationId: replay.applicationId === applicationId,
      },
      concurrent: {
        acceptedApplicationId: concurrentObservation.applicationId,
        rejected: concurrentDuplicate,
      },
      closing: {
        periodId: admissionPeriodId,
        acceptedApplicationId: applicationId,
        confirmationPreserved: true,
        rejection: closedApplication,
      },
      rejections: {
        duplicate: {
          tag: "DuplicatePublicApplication",
          commandId: duplicateCommandId,
        },
        replayConflict,
        validationTags,
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
    for (const canary of privateCanaries) {
      expect(evidence).not.toContain(canary);
    }
    await writeFile(evidencePath, `${evidence}\n`, "utf8");
  });
});
