import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { dashboardMount } from "../dashboard-base";

const FIXTURE_PORT = 8791;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;
const AUTH_TOKEN = "fixture-jwt-0025";
const AUTH_HEADER = `Bearer ${AUTH_TOKEN}`;

const apiRequests: Array<{ readonly method: string; readonly path: string }> = [];
let fixtureServer: Server | undefined;

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function handleFixtureRequest(request: IncomingMessage, response: ServerResponse): void {
  const path = new URL(request.url ?? "/", FIXTURE_URL).pathname;
  apiRequests.push({ method: request.method ?? "GET", path });

  if (request.headers.authorization !== AUTH_HEADER) {
    respondJson(response, 401, {
      type: "urn:vektorprogrammet:problem:v0.2:credential.missing",
      title: "Credential required",
      status: 401,
      code: "credential.missing",
      detail: "A credential is required for this operation.",
    });
    return;
  }

  if (path === "/api/profile" && request.method === "GET") {
    respondJson(response, 200, {
      personId: "2500",
      firstName: "Operator",
      lastName: "0025",
      email: "operator@example.invalid",
      phone: "+47 900 00 025",
      role: "ROLE_ADMIN",
      nameRevision: 0,
      contactRevision: 0,
    });
    return;
  }

  if (path === "/api/session" && request.method === "GET") {
    respondJson(response, 200, {
      sessionId: "fixture-session-0025",
      personId: "2500",
      current: true,
    });
    return;
  }

  respondJson(response, 404, {
    type: "urn:vektorprogrammet:problem:v0.2:route.not-found",
    title: "Route not found",
    status: 404,
    code: "route.not-found",
    detail: "The requested route does not exist.",
  });
}

const unavailablePages = [
  {
    route: "/dashboard/assistenter",
    heading: "Assistentoversikten er ikke tilgjengelig",
    body: "Den native tjenesten tilbyr ikke assistentdata ennå.",
  },
  {
    route: "/dashboard/vikarer",
    heading: "Vikaroversikten er ikke tilgjengelig",
    body: "Den native tjenesten tilbyr ikke vikardata ennå.",
  },
  {
    route: "/dashboard/sponsorer",
    heading: "Sponsoroversikten er ikke tilgjengelig",
    body: "Den native tjenesten tilbyr ikke sponsordata ennå.",
  },
  {
    route: "/dashboard/statistikk",
    heading: "Statistikken er ikke tilgjengelig",
    body: "Den native tjenesten tilbyr ikke opptaksstatistikk ennå.",
  },
] as const;

const unsupportedDataPaths = [
  "/api/admin/scheduling/assistants",
  "/api/admin/substitutes",
  "/api/admin/sponsors",
  "/api/admin/admission-stats",
] as const;

test.describe("dashboard unavailable native projections", () => {
  test.beforeAll(async () => {
    expect(process.env.API_MODE).toBeUndefined();
    expect(process.env.VITE_API_MODE).toBeUndefined();
    expect(process.env.API_URL).toBe(FIXTURE_URL);
    expect(process.env.VITE_API_URL).toBe(FIXTURE_URL);

    fixtureServer = createServer(handleFixtureRequest);
    await new Promise<void>((resolve, reject) => {
      fixtureServer?.once("error", reject);
      fixtureServer?.listen(FIXTURE_PORT, "127.0.0.1", resolve);
    });
  });

  test.afterAll(async () => {
    if (fixtureServer === undefined) return;
    await new Promise<void>((resolve, reject) => {
      fixtureServer?.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test("renders truthful unavailable states without unsupported data calls", async ({ page }) => {
    test.setTimeout(60_000);
    apiRequests.length = 0;
    await page.context().addCookies([
      {
        name: "jwt_token",
        value: AUTH_TOKEN,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    await page.goto(dashboardMount({}));
    await expect(
      page.getByRole("heading", { name: "Oversiktsdata er ikke tilgjengelig" }),
    ).toBeVisible();
    await expect(
      page.getByText("Assistent-, søknads- og intervjuoversikten er midlertidig utilgjengelig."),
    ).toBeVisible();

    for (const unavailable of unavailablePages) {
      await page.goto(unavailable.route);
      await expect(page.getByRole("heading", { name: unavailable.heading })).toBeVisible();
      await expect(page.getByText(unavailable.body, { exact: true })).toBeVisible();
    }

    expect(apiRequests.some(({ path }) => path === "/api/profile")).toBe(true);
    expect(
      apiRequests.filter(({ path }) => !["/api/profile", "/api/session"].includes(path)),
    ).toEqual([]);
    for (const path of unsupportedDataPaths) {
      expect(apiRequests.some((request) => request.path === path)).toBe(false);
    }
  });
});
