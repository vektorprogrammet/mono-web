import { expect, test, type Page } from "@playwright/test";

const apiOrigin = process.env.API_URL ?? "http://127.0.0.1:8000";
const viewerUsername = "framework-runtime-0032";
const viewerPassword = "framework-runtime-password-0032";

async function loginWithApi(page: Page): Promise<string> {
  const response = await page.request.post(`${apiOrigin}/api/login`, {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    data: { username: viewerUsername, password: viewerPassword },
  });
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as { token?: unknown };
  expect(typeof payload.token).toBe("string");
  return payload.token as string;
}

function requireFrameworkRuntimeMode(): void {
  test.skip(
    process.env.REAL_SYMFONY_CONTENT_OPS_E2E !== "1",
    "requires the real Symfony content operations command",
  );
  expect(process.env.REAL_SYMFONY_CONTENT_OPS_E2E).toBe("1");
  expect(process.env.API_MODE).not.toBe("fixture");
  expect(process.env.VITE_API_MODE).not.toBe("fixture");
}

test.describe("Real Symfony framework runtime plumbing journey", () => {
  test.describe.configure({ retries: 0, mode: "serial" });

  test("framework-runtime-plumbing", async ({ page }) => {
    requireFrameworkRuntimeMode();

    const docs = await page.goto(`${apiOrigin}/api/docs`);
    expect(docs?.status()).toBe(200);
    expect((await page.locator("body").innerText()).length).toBeGreaterThan(20);
    const token = await loginWithApi(page);

    const entrypoint = await page.request.get(`${apiOrigin}/api/`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    expect(entrypoint.status()).toBe(200);
    expect((await entrypoint.text()).length).toBeGreaterThan(0);

    const context = await page.request.get(`${apiOrigin}/api/contexts/Article`, {
      headers: { Accept: "application/ld+json", Authorization: `Bearer ${token}` },
    });
    expect(context.status()).toBe(200);
    expect((await context.text()).length).toBeGreaterThan(0);

    const validationErrors = await page.request.get(`${apiOrigin}/api/validation_errors/1`, {
      headers: { Accept: "application/ld+json", Authorization: `Bearer ${token}` },
    });
    expect([200, 404]).toContain(validationErrors.status());
    expect((await validationErrors.text()).length).toBeGreaterThan(0);

    const errors = await page.request.get(`${apiOrigin}/api/errors/400`, {
      headers: { Accept: "application/ld+json", Authorization: `Bearer ${token}` },
    });
    expect([200, 400]).toContain(errors.status());
    expect((await errors.text()).length).toBeGreaterThan(0);

    const root = await page.request.get(`${apiOrigin}/`);
    expect(root.status()).toBe(200);
    expect((await root.text()).length).toBeGreaterThan(0);
  });
});
