import { expect, test, type APIResponse, type Page } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const operatorUsername = "content-publication-operator-0032";
const operatorPassword = "content-publication-password-0032";
const viewerUsername = "content-publication-viewer-0032";
const viewerPassword = "content-publication-viewer-password-0032";

function requireContentPublicationMode(): void {
  test.skip(
    process.env.REAL_SYMFONY_CONTENT_OPS_E2E !== "1",
    "requires the real Symfony content operations command",
  );
  expect(process.env.REAL_SYMFONY_CONTENT_OPS_E2E).toBe("1");
  expect(process.env.API_MODE).not.toBe("fixture");
  expect(process.env.VITE_API_MODE).not.toBe("fixture");
}

async function loginWithUi(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Innlogging", exact: true })).toBeVisible();
  await page.getByLabel("Brukernavn / e-post").fill(username);
  await page.getByLabel("Passord").fill(password);
  await page.getByRole("button", { name: "Logg inn", exact: true }).click();
  await expect(page).toHaveURL(/\/kontrollpanel$/);
}

async function loginWithApi(page: Page, username: string, password: string): Promise<string> {
  const response = await page.request.post(`${apiOrigin}/api/login`, {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    data: { username, password },
  });
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as { token?: unknown };
  expect(typeof payload.token).toBe("string");
  return payload.token as string;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/ld+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function expectProblem(response: APIResponse, statuses: readonly number[]): Promise<void> {
  expect(statuses).toContain(response.status());
  const body = await response.text();
  expect(body.length).toBeGreaterThan(0);
}

test.describe("Real Symfony content publication journey", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("content-publication", async ({ page }) => {
    requireContentPublicationMode();

    const viewerToken = await loginWithApi(page, viewerUsername, viewerPassword);
    const unauthorized = await page.request.post(`${apiOrigin}/api/admin/changelogs`, {
      headers: headers(viewerToken),
      data: { title: "Unauthorized content publication" },
    });
    await expectProblem(unauthorized, [401, 403]);

    await loginWithUi(page, operatorUsername, operatorPassword);
    const operatorToken = await loginWithApi(page, operatorUsername, operatorPassword);

    const invalid = await page.request.post(`${apiOrigin}/api/admin/changelogs`, {
      headers: headers(operatorToken),
      data: {
        title: "",
        description: "The title invariant must reject an empty publication.",
        date: "2032-09-01T12:00:00+00:00",
        githubLink: "https://github.invalid/content-publication-0032",
      },
    });
    await expectProblem(invalid, [400, 422]);

    const title = "Content publication release 0032";
    const created = await page.request.post(`${apiOrigin}/api/admin/changelogs`, {
      headers: headers(operatorToken),
      data: {
        title,
        description: "Deterministic content publication through Symfony.",
        date: "2032-09-01T12:00:00+00:00",
        githubLink: "https://github.invalid/content-publication-0032",
      },
    });
    const createdBody = await created.text();
    expect(created.status(), createdBody).toBe(201);
    expect(createdBody).toBe("");

    const freshRead = await page.request.get(`${apiOrigin}/api/change_log_items`, {
      headers: { Accept: "application/ld+json" },
    });
    expect(freshRead.status()).toBe(200);
    const readPayload = (await freshRead.json()) as {
      "hydra:member"?: Array<{ title?: unknown }>;
      member?: Array<{ title?: unknown }>;
    };
    const changelogs = readPayload["hydra:member"] ?? readPayload.member ?? [];
    expect(changelogs.some((item) => item.title === title)).toBe(true);

    const rendered = await page.goto(`${apiOrigin}/kontrollpanel/changelog/show/all`);
    expect(rendered?.status()).toBe(200);
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  });
});
