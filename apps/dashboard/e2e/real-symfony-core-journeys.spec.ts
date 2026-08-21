import { fileURLToPath } from "node:url";
import { expect, test, type APIResponse, type Page } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const departmentId = 1;
const fieldOfStudyId = 1;
const surveyId = 1;
const surveyQuestionId = 1;
const coreUsername = "core-journey-user-0032";
const corePassword = "core-journey-password-0032";
const coreEmail = "core-journey-user-0032@example.invalid";
const receiptImagePath = fileURLToPath(
  new URL("../../server/images/receipts/698c00086228f.png", import.meta.url),
);

const journeys = {
  applicantAdmission: {
    journeyRefId: "intent://journey:parity:applicant_admission:v1",
    stepIds: [
      "applicant-admission-api-operation",
      "applicant-admission-command-write",
      "applicant-admission-legacy-route",
      "applicant-admission-mono-route",
    ],
  },
  contactPublic: {
    journeyRefId: "intent://journey:parity:contact_public:v1",
    stepIds: [
      "contact-public-api-operation",
      "contact-public-command-write",
      "contact-public-legacy-route",
      "contact-public-mono-route",
    ],
  },
  contentPublic: {
    journeyRefId: "intent://journey:parity:content_public:v1",
    stepIds: [
      "content-public-api-operation",
      "content-public-command-write",
      "content-public-legacy-route",
      "content-public-mono-route",
    ],
  },
  filesMedia: {
    journeyRefId: "intent://journey:parity:files_media:v1",
    stepIds: [
      "files-media-command-write",
      "files-media-legacy-route",
      "files-media-mono-route",
    ],
  },
  identitySelf: {
    journeyRefId: "intent://journey:parity:identity_self:v1",
    stepIds: [
      "identity-self-api-operation",
      "identity-self-command-write",
      "identity-self-legacy-route",
      "identity-self-mono-route",
    ],
  },
  receiptSelf: {
    journeyRefId: "intent://journey:parity:receipt_self:v1",
    stepIds: [
      "receipt-self-api-operation",
      "receipt-self-command-write",
      "receipt-self-legacy-route",
      "receipt-self-mono-route",
    ],
  },
  surveyParticipate: {
    journeyRefId: "intent://journey:parity:survey_participate:v1",
    stepIds: [
      "survey-participate-api-operation",
      "survey-participate-command-write",
      "survey-participate-legacy-route",
      "survey-participate-mono-route",
    ],
  },
  teamInterestSelf: {
    journeyRefId: "intent://journey:parity:team_interest_self:v1",
    stepIds: [
      "team-interest-self-api-operation",
      "team-interest-self-command-write",
      "team-interest-self-legacy-route",
      "team-interest-self-mono-route",
    ],
  },
} as const;

export { journeys };

function requireCoreMode(): void {
  test.skip(
    process.env.REAL_SYMFONY_CORE_E2E !== "1",
    "requires the real Symfony core journey command",
  );
  expect(process.env.REAL_SYMFONY_CORE_E2E).toBe("1");
  expect(process.env.API_MODE).not.toBe("fixture");
  expect(process.env.VITE_API_MODE).not.toBe("fixture");
}

async function loginWithUi(page: Page): Promise<string> {
  await page.goto("/login");
  await expect(
    page.getByRole("heading", { name: "Innlogging", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Brukernavn / e-post").fill(coreUsername);
  await page.getByLabel("Passord").fill(corePassword);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(/\/kontrollpanel$/);

  const response = await page.request.post(`${apiOrigin}/api/login`, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    data: {
      username: coreUsername,
      password: corePassword,
    },
  });
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as { token?: unknown };
  expect(typeof payload.token).toBe("string");
  return payload.token as string;
}

function bearerHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function expectEmptyCreatedResponse(response: APIResponse): Promise<void> {
  expect(response.status()).toBe(201);
  expect(await response.text()).toBe("");
}

test.describe("Real Symfony core user journeys", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("applicant-admission", async ({ page }) => {
    requireCoreMode();

    await page.goto(`/opptak/avdeling/${departmentId}`);
    await page.locator(`#department-box-tabs a[aria-controls="${departmentId}"]`).click();
    const form = page.locator(`form[name="application_${departmentId}"]`);
    await expect(form).toBeVisible();
    await form.getByLabel("Fornavn").fill("Applicant");
    await form.getByLabel("Etternavn").fill("Core Journey");
    await form.getByLabel("E-post").fill("applicant-admission-0032@example.invalid");
    await form.getByLabel("Telefon").fill("90000032");
    await form.getByLabel("Kjønn").selectOption({ label: "Dame" });
    await form.getByLabel("Linje").selectOption({ label: "CORE-STUDY" });
    await form.getByLabel("Årstrinn").selectOption({ label: "1. klasse" });
    await form.getByRole("button", { name: "Søk nå!", exact: true }).click();
    await expect(page).toHaveURL(/\/assistenter\/opptak\/bekreftelse$/);
    await expect(
      page.getByText(/søknad|registrert/i).first(),
    ).toBeVisible();

    const apiResponse = await page.request.post(`${apiOrigin}/api/applications`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      data: {
        firstName: "API Applicant",
        lastName: "Core Journey",
        email: "applicant-admission-api-0032@example.invalid",
        phone: "90000033",
        fieldOfStudyId,
        yearOfStudy: "1. klasse",
        gender: 0,
        departmentId,
      },
    });
    await expectEmptyCreatedResponse(apiResponse);
  });

  test("contact-public", async ({ page }) => {
    requireCoreMode();

    await page.goto(`/kontakt/avdeling/${departmentId}`);
    const form = page.locator('form[name="support_ticket"]');
    await expect(form).toBeVisible();
    await form.getByLabel("Ditt navn").fill("Contact Core Journey");
    await form.getByLabel("Din e-post").fill("contact-public-0032@example.invalid");
    await form.getByLabel("Emne").fill("Core journey contact");
    await form.getByLabel("Melding").fill("Contact submission crosses the Symfony form boundary.");
    await form.getByRole("button", { name: "Send melding", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/kontakt/avdeling/${departmentId}$`));
    await expect(page.getByText(/Kontaktforespørsel sendt/i)).toBeVisible();

    const apiResponse = await page.request.post(`${apiOrigin}/api/contact_messages`, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      data: {
        name: "API Contact Core Journey",
        email: "contact-public-api-0032@example.invalid",
        departmentId,
        subject: "Core journey API contact",
        message: "The current Symfony contact API operation was traversed.",
      },
    });
    await expectEmptyCreatedResponse(apiResponse);
  });

  test("content-public", async ({ page }) => {
    requireCoreMode();

    await page.goto("/nyhet/core-journey-article");
    await expect(
      page.getByRole("heading", { name: "Core journey article", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Core journey content rendered by Symfony.")).toBeVisible();

    const apiResponse = await page.request.get(`${apiOrigin}/api/articles`, {
      headers: { Accept: "application/json" },
    });
    expect(apiResponse.status()).toBe(200);
    const payload = (await apiResponse.json()) as
      | Array<{ slug?: string }>
      | { member?: Array<{ slug?: string }> };
    const articles = Array.isArray(payload) ? payload : payload.member;
    expect(articles).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "core-journey-article" })]),
    );
  });

  test("files-media", async ({ page }) => {
    requireCoreMode();

    const mediaResponses: Array<{ status: number; contentType: string }> = [];
    page.on("response", (response) => {
      if (response.url().includes("/images/assistenter.jpg")) {
        mediaResponses.push({
          status: response.status(),
          contentType: response.headers()["content-type"] ?? "",
        });
      }
    });

    await page.goto("/foreldre");
    const media = page.locator('img[src*="images/assistenter.jpg"]').first();
    await expect(media).toBeVisible();
    await expect.poll(async () =>
      media.evaluate((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
    ).toBe(true);
    expect(mediaResponses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 200, contentType: expect.stringMatching(/^image\//) }),
      ]),
    );
  });

  test("identity-self", async ({ page }) => {
    requireCoreMode();

    const token = await loginWithUi(page);
    await page.goto("/profile");
    await expect(
      page.getByRole("heading", { name: "Core Journey", exact: true }),
    ).toBeVisible();

    const apiResponse = await page.request.get(`${apiOrigin}/api/me`, {
      headers: bearerHeaders(token),
    });
    expect(apiResponse.status()).toBe(200);
    const payload = (await apiResponse.json()) as {
      firstName?: string;
      lastName?: string;
      email?: string;
    };
    expect(payload).toMatchObject({
      firstName: "Core",
      lastName: "Journey",
      email: coreEmail,
    });
  });

  test("receipt-self", async ({ page }) => {
    requireCoreMode();

    const token = await loginWithUi(page);
    await page.goto("/utlegg");
    await page.locator("#newReceiptLink").click();
    const form = page.locator('form[name="receipt"]');
    await expect(form).toBeVisible();
    const now = new Date();
    const day = String(now.getDate()).padStart(2, "0");
    const month = String(now.getMonth() + 1);
    const year = String(now.getFullYear());
    const description = "Core journey receipt 0032";
    await form.locator('textarea[name="receipt[description]"]').fill(description);
    await form.locator('input[name="receipt[sum]"]').fill("12.34");
    await form.locator('select[name="receipt[receiptDate][day]"]').selectOption(day);
    await form.locator('select[name="receipt[receiptDate][month]"]').selectOption(month);
    await form.locator('select[name="receipt[receiptDate][year]"]').selectOption(year);
    await form.locator('input[name="receipt[user][account_number]"]').fill("1234.56.78903");
    await form.locator('input[name="receipt[picturePath]"]').setInputFiles(receiptImagePath);
    await Promise.all([
      page.waitForURL(/\/utlegg$/),
      form.getByRole("button", { name: "Be om refusjon", exact: true }).click(),
    ]);
    const receiptRow = page
      .locator("#activeReceiptsTable tbody tr")
      .filter({ hasText: description });
    await expect(receiptRow).toBeVisible();
    await expect(receiptRow.getByText("Vis kvittering", { exact: true })).toBeVisible();

    const apiResponse = await page.request.post(`${apiOrigin}/api/receipts`, {
      headers: {
        ...bearerHeaders(token),
        "Content-Type": "application/json",
      },
      data: {
        description: "Core journey API receipt 0032",
        sum: 3.21,
        receiptDate: `${year}-${month.padStart(2, "0")}-${day}`,
      },
    });
    expect(apiResponse.status()).toBe(201);
    const payload = (await apiResponse.json()) as { id?: unknown };
    expect(typeof payload.id).toBe("number");

    await page.reload();
    await expect(
      page.locator("#activeReceiptsTable tbody tr").filter({ hasText: description }),
    ).toBeVisible();
  });

  test("survey-participate", async ({ page }) => {
    requireCoreMode();

    await page.goto(`/undersokelse/${surveyId}`);
    await expect(
      page.getByRole("heading", { name: "Core anonymous survey", exact: true }),
    ).toBeVisible();
    await page.locator('select[name="surveyTaken[school]"]').selectOption({ label: "Core journey school" });
    await page.getByLabel("Hva er din favorittfarge?").fill("blå");
    await page.getByRole("button", { name: "Send inn", exact: true }).click();
    await expect(page.getByText("Core survey complete.", { exact: true })).toBeVisible();

    const apiResponse = await page.request.post(
      `${apiOrigin}/api/surveys/${surveyId}/respond`,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        data: {
          answers: [{ questionId: surveyQuestionId, answer: "grønn" }],
        },
      },
    );
    expect(apiResponse.status()).toBe(204);
    expect(await apiResponse.text()).toBe("");
  });

  test("team-interest-self", async ({ page }) => {
    requireCoreMode();

    await page.goto(`/teaminteresse/${departmentId}`);
    await expect(
      page.getByRole("heading", { name: "Meld interesse for team", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Navn").fill("Team Interest Core Journey");
    await page.getByLabel("Email").fill("team-interest-0032@example.invalid");
    await page.getByLabel("Core journey team").check();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/teaminteresse/${departmentId}$`));
    await expect(page.getByLabel("Navn")).toHaveValue("");
    await expect(page.getByLabel("Email")).toHaveValue("");

    await page.goto(`/teaminteresse/${departmentId}`);
    await expect(
      page.getByRole("heading", { name: "Meld interesse for team", exact: true }),
    ).toBeVisible();

    const token = await loginWithUi(page);
    const apiResponse = await page.request.get(`${apiOrigin}/api/admin/team-interest`, {
      headers: bearerHeaders(token),
    });
    expect(apiResponse.status()).toBe(200);
    const payload = (await apiResponse.json()) as {
      applicants?: unknown[];
      teams?: unknown[];
    };
    expect(payload).toEqual({
      applicants: [],
      teams: [{ id: expect.any(Number), name: "Core journey team" }],
    });
  });
});
