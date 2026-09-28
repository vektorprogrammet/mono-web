import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { dashboardMount } from "../dashboard-base";
import { journeyClock } from "../../../tools/e2e/journey-clock.js";
import {
  isNativeRpcRequest,
  nativeRpcProblem,
  nativeRpcSuccess,
  readNativeRpcCall,
} from "../test/native-rpc.js";


const FIXTURE_PORT = 8791;

const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}`;

const SESSION_TOKEN = "fixture-session-0025";

const SESSION_COOKIE = `better-auth.session_token=${SESSION_TOKEN}`;

// The fixture session's instants. No clock compares them, so they derive from one pinned instant.
const sessionClock = journeyClock("2031-09-15T12:00:00.000Z");

const FIXTURE_ETAG = '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"';

const apiRequests: Array<{
  readonly method: string;
  readonly path: string;
  readonly tag: string | undefined;
  readonly cookie: string | null;
}> = [];

let fixtureServer: Server | undefined;

/** Writes a web response through the fixture's Node response. */
async function writeResponse(response: ServerResponse, answer: Response): Promise<void> {
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(Buffer.from(await answer.arrayBuffer()));
}

/** The fixture backend: the session and the profile RPCs, for the one fixture session. */
async function answerFixtureRequest(request: IncomingMessage): Promise<Response> {
  const url = new URL(request.url ?? "/", FIXTURE_URL);
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(Buffer.from(chunk));

  const body = Buffer.concat(chunks);

  if (request.method !== "POST" || !isNativeRpcRequest(url)) {
    apiRequests.push({ method: request.method ?? "GET", path: url.pathname, tag: undefined, cookie: null });

    return new Response(null, { status: 404 });
  }

  const call = await readNativeRpcCall(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  const cookie = call.headers.get("cookie");
  apiRequests.push({ method: "POST", path: url.pathname, tag: call.tag, cookie });

  if (cookie !== SESSION_COOKIE) return nativeRpcProblem(call, "credential.missing");

  if (call.tag === "profile.readOwnProfile") {
    return nativeRpcSuccess(call, {
      profile: {
        personId: "2500",
        firstName: "Operator",
        lastName: "0025",
        email: "operator@example.invalid",
        phone: "+47 900 00 025",
        role: "ROLE_ADMIN",
        nameRevision: 0,
        contactRevision: 0,
      },
      etag: FIXTURE_ETAG,
    });
  }

  if (call.tag === "system.readSession") {
    return nativeRpcSuccess(call, {
      sessionId: "fixture-session-0025",
      personId: "2500",
      createdAt: sessionClock.now,
      updatedAt: sessionClock.now,
      expiresAt: sessionClock.fromNow(1),
      ipAddress: null,
      userAgent: null,
      current: true,
    });
  }

  return nativeRpcProblem(call, "resource.not-found");
}

function handleFixtureRequest(request: IncomingMessage, response: ServerResponse): void {
  void answerFixtureRequest(request).then(
    (answer) => writeResponse(response, answer),
    () => writeResponse(response, new Response(null, { status: 500 })),
  );
}

// /dashboard/assistenter is the native volunteer affiliation and school placement page, not an
// unavailable projection; no page calls the legacy assistant overview in unsupportedDataPaths.
const unavailablePages = [
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
        name: "better-auth.session_token",
        value: SESSION_TOKEN,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    await page.goto(dashboardMount({}));
    expect(new URL(page.url()).pathname).toBe(dashboardMount({}));
    await expect(
      page.getByRole("heading", { name: "Oversiktsdata er ikke tilgjengelig" }),
    ).toBeVisible();
    await expect(
      page.getByText("Assistent-, søknads- og intervjuoversikten er midlertidig utilgjengelig."),
    ).toBeVisible();

    for (const unavailable of unavailablePages) {
      await page.goto(unavailable.route);
      expect(new URL(page.url()).pathname).toBe(unavailable.route);
      await expect(page.getByRole("heading", { name: unavailable.heading })).toBeVisible();
      await expect(page.getByText(unavailable.body, { exact: true })).toBeVisible();
    }

    expect(apiRequests.some(({ tag }) => tag === "profile.readOwnProfile")).toBe(true);
    expect(
      apiRequests.filter(
        ({ tag }) => tag !== "profile.readOwnProfile" && tag !== "system.readSession",
      ),
    ).toEqual([]);
    expect(apiRequests.every(({ cookie }) => cookie === SESSION_COOKIE)).toBe(true);

    for (const path of unsupportedDataPaths) {
      expect(apiRequests.some((request) => request.path === path)).toBe(false);
    }
  });
});
