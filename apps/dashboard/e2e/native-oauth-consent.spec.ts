import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const realRun = process.env.REAL_NATIVE_OAUTH_E2E === "1";
const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? "";
const apiOrigin = process.env.API_URL ?? "";
const clientId = process.env.OAUTH_E2E_CLIENT_ID ?? "";
const redirectUri = process.env.OAUTH_E2E_REDIRECT_URI ?? "";
const email = process.env.OAUTH_E2E_EMAIL ?? "";
const password = process.env.OAUTH_E2E_PASSWORD ?? "";

if (
  realRun &&
  [dashboardOrigin, apiOrigin, clientId, redirectUri, email, password].some((value) => value === "")
) {
  throw new Error("native OAuth browser evidence requires process-bound loopback inputs");
}

const authorizationRequest = () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const state = randomBytes(32).toString("base64url");
  const url = new URL("/api/auth/oauth2/authorize", apiOrigin);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", "urn:vektorprogrammet:native-api");
  url.searchParams.set("scope", "native-api offline_access");
  url.searchParams.set("prompt", "consent");
  return { url, state };
};

const openSignedLogin = async (page: Page) => {
  const authorization = authorizationRequest();
  await page.goto(authorization.url.toString());
  await expect(page).toHaveURL(new RegExp(`^${dashboardOrigin}/dashboard/login\\?`));
  return { ...authorization, loginUrl: new URL(page.url()) };
};

const dsl = realRun ? test.describe : test.describe.skip;

dsl("native OAuth dashboard consent", () => {
  test("rejects a wrong pending request and a tampered provider signature", async ({ page }) => {
    const { loginUrl } = await openSignedLogin(page);
    const wrong = new URL(loginUrl);
    wrong.searchParams.set("resource", "urn:wrong-resource");
    const wrongPage = await page.context().newPage();
    const wrongResponse = await wrongPage.goto(wrong.toString());
    expect(wrongResponse?.status()).toBe(400);
    expect((await wrongResponse?.allHeaders())?.["cache-control"]).toBe("no-store");
    await expect(wrongPage.getByRole("alert")).toContainText("ugyldig");

    await wrongPage.close();
    const tampered = new URL(loginUrl);
    const signature = tampered.searchParams.get("sig");
    if (signature === null || signature.length === 0) throw new Error("provider signature missing");
    tampered.searchParams.set(
      "sig",
      `${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`,
    );
    const tamperedPage = await page.context().newPage();
    await tamperedPage.goto(tampered.toString());
    await tamperedPage.getByLabel("E-post").fill(email);
    await tamperedPage.getByLabel("Passord").fill(password);
    const tamperedResponse = tamperedPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.startsWith("/dashboard/login"),
    );
    await tamperedPage.getByRole("button", { name: "Logg inn" }).click();
    expect((await tamperedResponse).status()).toBe(400);
    await expect(tamperedPage).toHaveURL(/\/dashboard\/login\?/u);
    await expect(tamperedPage.getByRole("alert")).toContainText("ugyldig");
    await expect(tamperedPage.context().cookies()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "better-auth.session_token" })]),
    );
    await tamperedPage.close();
  });

  test("rejects an untrusted form origin before credential dispatch", async ({ page, request }) => {
    const { loginUrl } = await openSignedLogin(page);
    const response = await request.post(loginUrl.toString(), {
      headers: { Origin: "https://untrusted.example" },
      form: { email, password },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(400);
    expect(response.headers()["content-type"]).toContain("text/plain");
  });

  test("continues sign-in through explicit consent to one authorization code", async ({ page }) => {
    const { state } = await openSignedLogin(page);
    await page.getByLabel("E-post").fill(email);
    await page.getByLabel("Passord").fill(password);
    await page.getByRole("button", { name: "Logg inn" }).click();
    await expect(page).toHaveURL(new RegExp(`^${dashboardOrigin}/dashboard/oauth/consent\\?`));
    const consentPage = await page.reload();
    expect(consentPage?.status()).toBe(200);
    expect((await consentPage?.allHeaders())?.["cache-control"]).toBe("no-store");
    await expect(page).toHaveURL(new RegExp(`^${dashboardOrigin}/dashboard/oauth/consent\\?`));
    await expect(page.getByRole("heading", { name: /Dashboard OAuth proof/u })).toBeVisible();
    await expect(page.getByText("offentlig OAuth-klient", { exact: false })).toBeVisible();
    await expect(page.getByText("Access the Vektorprogrammet native API")).toBeVisible();
    await expect(
      page.getByText("Stay connected for up to 30 days, with use at least every 7 days"),
    ).toBeVisible();
    await expect(page.getByText("Vektorprogrammet native API", { exact: true })).toBeVisible();
    await expect(page.getByText(new URL(redirectUri).origin, { exact: true })).toBeVisible();

    const consentActionResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.startsWith("/dashboard/oauth/consent"),
    );
    await page.getByRole("button", { name: "Godta" }).click();
    const consentAction = await consentActionResponse;
    expect(consentAction.status()).toBe(202);
    expect((await consentAction.allHeaders())["cache-control"]).toBe("no-store");
    await page.waitForURL((url) => url.origin + url.pathname === redirectUri);
    const callback = new URL(page.url());
    expect(callback.searchParams.get("state")).toBe(state);
    expect(callback.searchParams.get("iss")).toBe(`${apiOrigin}/api/auth`);
    expect(callback.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{32,512}$/u);
  });
});
