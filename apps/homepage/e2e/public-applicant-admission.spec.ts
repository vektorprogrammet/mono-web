import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  AdmissionPeriodId,
  nativeRpcPath,
  ReadApplicationConfirmation,
  SubmitApplicationRequest,
} from "@vektorprogrammet/rpc";
import { IdempotencyKey, StrongETag } from "@vektorprogrammet/rpc/problem";
import { nativeScriptClient, type ScriptCallResult } from "@vektorprogrammet/rpc/script";
import { Schema, Struct } from "effect";
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
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

type ApplicantAvailability = SubmitApplicationRequest["availability"];

type UnavailableWeekday = Extract<keyof ApplicantAvailability, `${string}Unavailable`>;

/** Tuesday does not suit; four weeks in either block, at a Norwegian school. */
const APPLICANT_AVAILABILITY: ApplicantAvailability = {
  mondayUnavailable: false,
  tuesdayUnavailable: true,
  wednesdayUnavailable: false,
  thursdayUnavailable: false,
  fridayUnavailable: false,
  positionWeeks: 4,
  preferredGroup: "all",
  language: "Norsk",
};

/** The labels that an applicant reads, so the browser answers the way a person does. */
const WEEKDAY_LABELS: Readonly<Record<UnavailableWeekday, string>> = {
  mondayUnavailable: "Mandag",
  tuesdayUnavailable: "Tirsdag",
  wednesdayUnavailable: "Onsdag",
  thursdayUnavailable: "Torsdag",
  fridayUnavailable: "Fredag",
};

type PositionAnswer = Pick<ApplicantAvailability, "positionWeeks" | "preferredGroup"> & {
  readonly label: string;
};

const POSITION_ANSWERS: ReadonlyArray<PositionAnswer> = [
  { label: "4 uker, bolk 1 eller bolk 2", positionWeeks: 4, preferredGroup: "all" },
  { label: "4 uker, bare bolk 1", positionWeeks: 4, preferredGroup: "block-1" },
  { label: "4 uker, bare bolk 2", positionWeeks: 4, preferredGroup: "block-2" },
  { label: "8 uker, begge bolkene", positionWeeks: 8, preferredGroup: "all" },
];

const LANGUAGE_LABELS: Readonly<Record<ApplicantAvailability["language"], string>> = {
  Norsk: "Norsk skole",
  Engelsk: "Internasjonal skole (engelsk)",
  "Norsk og engelsk": "Begge passer",
};

const decodeStrict = <S extends Schema.ConstraintDecoder<unknown, never>>(schema: S) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" });

const SubmitApplicationConfirmationId = ReadApplicationConfirmation.payloadSchema.fields.applicationId;

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
  /** Wider than the contract, so a law can send a length or a language that it rejects. */
  readonly availability: Omit<ApplicantAvailability, "positionWeeks" | "language"> & {
    readonly positionWeeks: number;
    readonly language: string;
  };
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
    availability: APPLICANT_AVAILABILITY,
    ...overrides,
  };
}

/** A submitted body; the excess-property law adds a member the contract does not declare. */
type SubmittedApplication = ApplicationInput & { readonly applicantId?: string };

/** The backend's native RPC client, one public call at a time. */
const native = nativeScriptClient(BACKEND_ORIGIN);

/**
 * Submits one application under its own idempotency key unless a replay names one. The input
 * decodes through the contract first, so only a value that the contract admits is sent typed.
 */
function submit(data: ApplicationInput, idempotencyKey: string = randomUUID()) {
  const request = decodeStrict(SubmitApplicationRequest)(data);

  return native.call({}, (client) =>
    client["admissions.submitApplication"]({
      idempotencyKey: IdempotencyKey.make(idempotencyKey),
      request,
    }),
  );
}

/** A problem answer: the registry status and the code of the declared problem. */
function expectProblem<A>(result: ScriptCallResult<A>, status: number, code: string) {
  expect(result).toMatchObject({ ok: false, status, code });

  return { status, code };
}

/** The value of a successful call. */
function expectValue<A>(result: ScriptCallResult<A>): A {
  if (!result.ok) throw new Error(`The call failed with ${result.code}`);

  return result.value;
}

/** One RPC request on the JSON wire. */
const WireRequest = Schema.TaggedStruct("Request", {
  id: Schema.String,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
});

/** The one answer of a request that the server rejected with a defect before any handler ran. */
const RejectedBeforeHandler = Schema.Tuple([
  Schema.TaggedStruct("Exit", {
    exit: Schema.TaggedStruct("Failure", {
      cause: Schema.Tuple([Schema.TaggedStruct("Die", { defect: Schema.Unknown })]),
    }),
  }),
]);

/**
 * Sends one submission whose payload the contract does not admit, as untyped RPC wire JSON. The
 * RPC server rejects it while decoding, before the handler, so no command or receipt runs.
 */
async function submitUntyped(
  request: APIRequestContext,
  data: SubmittedApplication,
): Promise<{ readonly rejectedBeforeHandler: true }> {
  const response = await request.post(`${BACKEND_ORIGIN}${nativeRpcPath}`, {
    headers: { "content-type": "application/json" },
    data: WireRequest.make({
      id: "1",
      tag: "admissions.submitApplication",
      payload: { idempotencyKey: randomUUID(), request: data },
      headers: [],
    }),
  });

  expect(response.status()).toBe(200);
  // Decoding fails unless the answer is exactly one defect exit.
  Schema.decodeUnknownSync(RejectedBeforeHandler)(await response.json());

  return { rejectedBeforeHandler: true };
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

/** The boxes and radios that state an input's availability, by the labels an applicant reads. */
function availabilityControls(page: Page, input: ApplicationInput): Locator[] {
  const availability = decodeStrict(SubmitApplicationRequest.fields.availability)(
    input.availability,
  );

  const position = POSITION_ANSWERS.find(
    (answer) =>
      answer.positionWeeks === availability.positionWeeks &&
      answer.preferredGroup === availability.preferredGroup,
  );

  if (position === undefined) throw new Error("The form offers no answer for this position");

  return [
    ...Struct.keys(WEEKDAY_LABELS)
      .filter((weekday) => availability[weekday])
      .map((weekday) => page.getByRole("checkbox", { name: WEEKDAY_LABELS[weekday], exact: true })),
    page.getByRole("radio", { name: position.label, exact: true }),
    page.getByRole("radio", { name: LANGUAGE_LABELS[availability.language], exact: true }),
  ];
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

  for (const control of availabilityControls(page, input)) {
    await control.check();
  }
}

async function catalog() {
  return expectValue(
    await native.call({}, (client) => client["admissions.listApplicationOptions"]()),
  );
}

async function confirmation(applicationId: string) {
  return expectValue(
    await native.call({}, (client) =>
      client["admissions.readApplicationConfirmation"]({
        applicationId: decodeStrict(SubmitApplicationConfirmationId)(applicationId),
      }),
    ),
  );
}

test.use({ baseURL: HOMEPAGE_ORIGIN });

test.afterAll(() => native.dispose());

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

    const initialCatalog = await catalog();
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
        ...Struct.keys(WEEKDAY_LABELS).filter((weekday) => acceptedInput.availability[weekday]),
        "position",
        "language",
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

    // The homepage submitted the form's command ID as the idempotency key, so the same key and
    // payload replay the committed confirmation.
    const replay = expectValue(await submit(acceptedInput, submittedCommandId));
    expect(replay.applicationId).toBe(applicationId);

    const initialConfirmation = await confirmation(applicationId);
    expect(initialConfirmation.applicationId).toBe(applicationId);

    const replayConflict = expectProblem(
      await submit(applicationInput({ phone: "+47 911 11 111" }), submittedCommandId),
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

    for (const control of availabilityControls(page, duplicateInput)) {
      await expect(control).toBeChecked();
    }

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
      [
        applicationInput({ availability: { ...APPLICANT_AVAILABILITY, positionWeeks: 6 } }),
        "/availability/positionWeeks",
      ],
      [
        applicationInput({ availability: { ...APPLICANT_AVAILABILITY, language: "Svensk" } }),
        "/availability/language",
      ],
    ] as const;

    // A structurally invalid member fails the RPC payload schema in the server, before the
    // handler; the pointer of the member no longer reaches the client.
    const validation = [];

    for (const [data, pointer] of malformedInputs) {
      validation.push({ pointer, ...(await submitUntyped(request, data)) });
    }

    // The payload schema drops a member it does not declare, so the browser cannot select an
    // applicant identity: the submission is the canary applicant's second, a duplicate.
    const withApplicantId = {
      ...decodeStrict(SubmitApplicationRequest)(applicationInput()),
      applicantId: "browser-must-not-select-identity",
    };

    const excessAnswer = await native.call({}, (client) =>
      client["admissions.submitApplication"]({
        idempotencyKey: IdempotencyKey.make(randomUUID()),
        request: withApplicantId,
      }),
    );

    const excess = expectProblem(excessAnswer, 409, "application.duplicate");

    const bodyLimit = await submitUntyped(
      request,
      applicationInput({ firstName: "x".repeat(131_072) }),
    );

    // The frozen unions have no department problem, so an unknown department is invalid input.
    const unknownDepartmentAnswer = await submit(
      applicationInput({ departmentId: "department-unknown" }),
    );

    expect(unknownDepartmentAnswer).toMatchObject({
      ok: false,
      status: 422,
      code: "validation.failed",
      problem: {
        validation: { errors: [{ pointer: "/departmentId", code: "invalid" }], truncated: false },
      },
    });

    const unknownDepartment = { status: 422, code: "validation.failed", pointers: ["/departmentId"] };

    const unknownField = expectProblem(
      await submit(applicationInput({ fieldOfStudyId: "field-unknown" })),
      422,
      "application.invalid-field-of-study",
    );

    const inactiveField = expectProblem(
      await submit(applicationInput({ fieldOfStudyId: INACTIVE_FIELD_OF_STUDY_ID })),
      422,
      "application.invalid-field-of-study",
    );

    const crossDepartmentField = expectProblem(
      await submit(applicationInput({ fieldOfStudyId: FOREIGN_FIELD_OF_STUDY_ID })),
      422,
      "application.invalid-field-of-study",
    );

    const concurrentAnswers = await Promise.all([
      submit(applicationInput({ email: "concurrent-applicant-0039@example.invalid" })),
      submit(applicationInput({ email: "CONCURRENT-APPLICANT-0039@EXAMPLE.INVALID" })),
    ]);

    const concurrentAccepted = concurrentAnswers.filter((answer) => answer.ok);
    const concurrentRejected = concurrentAnswers.filter((answer) => !answer.ok);
    expect(concurrentAccepted).toHaveLength(1);
    expect(concurrentRejected).toHaveLength(1);

    const concurrentObservation = expectValue(concurrentAccepted[0]!);

    const concurrentDuplicate = expectProblem(concurrentRejected[0]!, 409, "application.duplicate");

    const closedPeriod = expectValue(
      await native.call({ cookie: leaderCookie, origin: staffOrigin }, (client) =>
        client["admissions.reviseAdmissionPeriod"]({
          admissionPeriodId: AdmissionPeriodId.make(admissionPeriodId),
          idempotencyKey: IdempotencyKey.make(randomUUID()),
          ifMatch: StrongETag.make(admissionPeriodETag),
          request: { endAt: closedEnd },
        }),
      ),
    );

    expect(closedPeriod).toMatchObject({
      id: admissionPeriodId,
      endAt: closedEnd,
      revision: admissionPeriodRevision + 1,
    });

    const confirmationAfterClose = await confirmation(applicationId);
    expect(confirmationAfterClose.applicationId).toBe(applicationId);

    const closedApplication = expectProblem(
      await submit(applicationInput({ email: "after-close-0039@example.invalid" })),
      409,
      "application.no-eligible-period",
    );

    expect((await catalog()).departments).toEqual([]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Ingen opptak er åpne nå" })).toBeVisible();

    // The RPC problem carries no Retry-After delay; the code alone states the spent limit.
    let rateLimited: { readonly status: number; readonly code: string } | undefined;

    for (let index = 0; index < rateLimitAttempts && !rateLimited; index += 1) {
      const answer = await submit(applicationInput({ email: `rate-limit-${index}@example.invalid` }));

      if (!answer.ok && answer.status === 429) {
        rateLimited = expectProblem(answer, 429, "rate-limit.exceeded");
      } else {
        expectProblem(answer, 409, "application.no-eligible-period");
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
        availability: acceptedInput.availability,
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
