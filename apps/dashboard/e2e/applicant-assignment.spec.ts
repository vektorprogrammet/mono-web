import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { z } from "zod";

const APP_URL = "http://127.0.0.1:5174";
const STUB_URL = "http://127.0.0.1:8789";
const TOKEN = "trace-token";
const configPrecheck = process.env.APPLICANT_CONFIG_PRECHECK === "1";

const bodyShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }),
  z.object({
    kind: z.literal("object"),
    keys: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("array"),
    keys: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("json"),
    keys: z.array(z.string()),
  }),
]);

const evidenceSchema = z.object({
  seed: z.literal("applicant-assignment-0018"),
  requests: z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      query: z.record(z.string()),
      status: z.number().int(),
      auth: z.enum(["bearer-present", "missing"]),
      accept: z.string(),
      contentType: z.string(),
      response: z.string(),
      body: bodyShapeSchema,
    }),
  ),
  transitions: z.array(z.string()),
  faults: z.array(
    z.object({
      operation: z.string(),
      status: z.number().int().optional(),
      malformed: z.string().optional(),
    }),
  ),
});

type Control =
  | { operation: "applications-list" | "users-list" | "schemas-list" | "assign"; status: number }
  | {
      operation: "applications-list" | "users-list" | "schemas-list";
      malformed: string;
    }
  | { clear: true };

type Evidence = z.infer<typeof evidenceSchema>;

async function resetStub(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${STUB_URL}/__applicant_stub/reset`);
  expect(response.status()).toBe(204);
}

async function controlStub(
  request: APIRequestContext,
  body: Control,
): Promise<void> {
  const response = await request.post(`${STUB_URL}/__applicant_stub/control`, {
    data: body,
  });
  expect(response.status()).toBe(204);
}

async function readEvidence(request: APIRequestContext): Promise<Evidence> {
  const response = await request.get(`${STUB_URL}/__applicant_stub/evidence`);
  expect(response.status()).toBe(200);
  return evidenceSchema.parse(await response.json());
}

async function authenticate(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: "jwt_token",
      value: TOKEN,
      url: APP_URL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function chooseAssignment(page: Page, row: Locator): Promise<void> {
  await row
    .getByRole("button", { name: "Tildel intervju", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  const interviewerSelect = dialog.getByRole("combobox").nth(0);
  await interviewerSelect.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Intervjuer Test", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Uegnet Test", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "Inaktiv Test", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("option", { name: "Intervjuer Test", exact: true })
    .click();

  const schemaSelect = dialog.getByRole("combobox").nth(1);
  await schemaSelect.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Førstegangsintervju", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("option", { name: "Førstegangsintervju", exact: true })
    .click();
}

test.describe("Applicant assignment SDK consumer seam", () => {
  test.describe.configure({ retries: 0 });

  test("isolated SSR configuration preflight", async ({ page }) => {
    test.skip(
      !configPrecheck,
      "requires the isolated SSR configuration preflight command",
    );
    await authenticate(page);
    const response = await page.request.get(
      `${APP_URL}/dashboard/sokere.data?_routes=routes%2Fdashboard.sokere._index`,
      { maxRedirects: 0 },
    );
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(
      "API-konfigurasjon mangler eller er ugyldig.",
    );
  });

  test("runs one non-fixture maintainer journey", async ({ page, request }) => {
    test.skip(configPrecheck, "separate isolated SSR configuration preflight");

    const browserProductRequests: string[] = [];
    page.on("request", (requestEvent) => {
      const url = new URL(requestEvent.url());
      if (url.hostname === "127.0.0.1" && url.port === "5174") {
        browserProductRequests.push(url.pathname);
      }
    });

    await resetStub(request);
    await page.context().clearCookies();
    await authenticate(page);

    await page.goto("/dashboard/sokere");
    await expect(page.getByRole("heading", { name: "Søkere" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Søkere" })).toBeVisible();
    for (const column of [
      "Navn",
      "E-post",
      "Status",
      "Intervjustatus",
      "Intervjuer",
      "Tidspunkt",
      "Handlinger",
    ]) {
      await expect(
        page.getByRole("columnheader", { name: column, exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByText("Applicant One", { exact: true })).toBeVisible();
    await expect(page.getByText("Applicant Two", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Nye", exact: true }).click();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(`${APP_URL}/dashboard/sokere?status=new`);
    await expect(page.getByRole("heading", { name: "Søkere" })).toBeVisible();

    let evidence = await readEvidence(request);
    expect(
      evidence.requests.some(
        (entry) =>
          entry.method === "GET" &&
          entry.path === "/api/admin/applications" &&
          entry.query.status === "new" &&
          entry.status === 200,
      ),
    ).toBe(true);
    const forbiddenBrowserPaths = [
      "/api/me/profile",
      "/api/admin/users",
      "/api/admin/interview-schemas",
      "/api/admin/applications",
      "/api/admin/interviews/assign",
    ];
    expect(
      browserProductRequests.filter((path) => forbiddenBrowserPaths.includes(path)),
    ).toEqual([]);

    const applicantOne = page.getByRole("row").filter({ hasText: "Applicant One" });
    await chooseAssignment(page, applicantOne);
    const assignmentDialog = page.getByRole("dialog");
    await assignmentDialog.getByRole("button", { name: "Tildel", exact: true }).click();
    await expect(applicantOne).toContainText("Intervjuer Test");
    await expect(
      applicantOne.getByRole("button", { name: "Tildel intervju", exact: true }),
    ).toHaveCount(0);

    evidence = await readEvidence(request);
    const assignmentRequest = evidence.requests.find(
      (entry) =>
        entry.method === "POST" &&
        entry.path === "/api/admin/interviews/assign" &&
        entry.status === 204,
    );
    expect(assignmentRequest).toBeDefined();
    expect(assignmentRequest).toMatchObject({
      auth: "bearer-present",
      accept: "absent",
      contentType: "application/json",
      response: "void",
      body: {
        kind: "json",
        keys: ["applicationId", "interviewerId", "schemaId"],
      },
    });
    expect(
      evidence.requests.filter(
        (entry) =>
          entry.method === "GET" &&
          entry.path === "/api/admin/applications" &&
          entry.query.status === "new" &&
          entry.status === 200,
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(evidence.transitions).toContain("application-assigned:101:201:301");

    await controlStub(request, { operation: "assign", status: 422 });
    const applicantTwo = page.getByRole("row").filter({ hasText: "Applicant Two" });
    await chooseAssignment(page, applicantTwo);
    const failedAssignmentDialog = page.getByRole("dialog");
    await failedAssignmentDialog
      .getByRole("button", { name: "Tildel", exact: true })
      .click();
    await expect(failedAssignmentDialog.getByRole("alert")).toContainText(
      "Kunne ikke tildele intervju",
    );
    const failedApplicantTwo = page
      .locator("tbody tr")
      .filter({ hasText: "Applicant Two" });
    await expect(failedApplicantTwo).toBeVisible();
    await expect(failedApplicantTwo).not.toContainText("Intervjuer Test");
    await failedAssignmentDialog
      .getByRole("button", { name: "Avbryt", exact: true })
      .click();
    const reopenedApplicantTwo = page
      .getByRole("row")
      .filter({ hasText: "Applicant Two" });
    await reopenedApplicantTwo
      .getByRole("button", { name: "Tildel intervju", exact: true })
      .click();
    const reopenedAssignmentDialog = page.getByRole("dialog");
    await expect(reopenedAssignmentDialog.getByRole("alert")).toHaveCount(0);
    await expect(reopenedAssignmentDialog.getByRole("combobox").nth(0)).toContainText(
      "Velg intervjuer",
    );
    await expect(reopenedAssignmentDialog.getByRole("combobox").nth(1)).toContainText(
      "Velg skjema",
    );
    await reopenedAssignmentDialog
      .getByRole("button", { name: "Avbryt", exact: true })
      .click();
    await controlStub(request, { clear: true });

    const applicationFaults = [
      [404, "Søkerlisten ble ikke funnet."],
      [409, "Søkerlisten er endret et annet sted. Last inn siden på nytt."],
      [429, "For mange forespørsler. Prøv igjen senere."],
      [500, "Kunne ikke laste søkere."],
    ] as const;
    for (const [status, message] of applicationFaults) {
      await controlStub(request, { operation: "applications-list", status });
      await page.goto("/dashboard/sokere?status=new");
      await expect(page.getByRole("alert")).toContainText(message);
      await expect(page.getByText("Applicant One", { exact: true })).toHaveCount(0);
      await controlStub(request, { clear: true });
    }
    await controlStub(request, {
      operation: "applications-list",
      malformed: "unknown-application-status",
    });
    await page.goto("/dashboard/sokere?status=new");
    await expect(page.getByRole("alert")).toContainText(
      "Kunne ikke laste søkere",
    );
    await expect(page.getByText("Applicant One", { exact: true })).toHaveCount(0);
    await controlStub(request, { clear: true });

    await controlStub(request, {
      operation: "users-list",
      malformed: "missing-activeUsers",
    });
    await page.goto("/dashboard/sokere?status=new");
    await expect(page.getByRole("alert")).toContainText(
      "Kunne ikke laste intervjualternativer",
    );
    await expect(page.getByText("Applicant One", { exact: true })).toHaveCount(0);
    await controlStub(request, { clear: true });

    await controlStub(request, {
      operation: "schemas-list",
      malformed: "hydra-envelope",
    });
    await page.goto("/dashboard/sokere?status=new");
    await expect(page.getByRole("alert")).toContainText(
      "Kunne ikke laste intervjualternativer",
    );
    await controlStub(request, { clear: true });
    await controlStub(request, { operation: "applications-list", status: 401 });
    const unauthorized = await request.get(
      `${APP_URL}/dashboard/sokere?status=new`,
      {
        headers: { Cookie: "jwt_token=trace-token" },
        maxRedirects: 0,
      },
    );
    expect(unauthorized.status()).toBe(302);
    expect(unauthorized.headers().location).toBe("/login?expired=true");
    await controlStub(request, { clear: true });

    await page.context().clearCookies();
    await page.goto("/dashboard/sokere");
    await expect(page).toHaveURL(`${APP_URL}/login`);
    await authenticate(page);

    evidence = await readEvidence(request);
    const rawEvidence = JSON.stringify(evidence);
    expect(rawEvidence).not.toContain(TOKEN);
    expect(rawEvidence).not.toContain("Applicant One");
    expect(rawEvidence).not.toContain("Applicant Two");
    expect(rawEvidence).not.toContain("@example.invalid");
    expect(rawEvidence).not.toContain("Fortell kort om motivasjonen din.");
    expect(rawEvidence).not.toContain("Synthetic assignment validation failure");
    expect(evidence.faults).toEqual([]);
    await test.info().attach("applicant-stub-evidence.json", {
      body: Buffer.from(rawEvidence),
      contentType: "application/json",
    });
  });
});
