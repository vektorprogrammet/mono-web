import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
  type Route,
} from "@playwright/test";
import { readBrowserStorage, readDocumentCookie } from "../browser/interview-response-state.js";

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5185";
const REAL_NATIVE_INVITATION_RESPONSE_E2E = process.env.REAL_NATIVE_INVITATION_RESPONSE_E2E === "1";
const INVITATION_COOKIE_PREFIX = "recruitment_invitation_capability_";
const INVITATION_INTERACTION_HEADER = "X-Recruitment-Invitation-Interaction-Id";
const INVITATION_INTERACTION_PATTERN = /^[a-f0-9]{32}$/;

type ResponseState = "Pending" | "Accepted" | "Rejected" | "RequestedNewTime";
type ApplicantCase = {
  readonly key: "accepted" | "rejected" | "requested-new-time";
  readonly capabilityEnvironment: string;
  readonly applicantName: string;
  readonly scheduledAt: string;
  readonly room: string;
  readonly campus: string;
  readonly operation: "confirmInvitation" | "rejectInvitation" | "requestNewInvitationTime";
  readonly actionLabel: string;
  readonly finalState: Exclude<ResponseState, "Pending">;
  readonly stateLabel: string;
  readonly responseMessage: string | null;
};

const APPLICANT_CASES: readonly ApplicantCase[] = [
  {
    key: "accepted",
    capabilityEnvironment: "INVITATION_RESPONSE_E2E_ACCEPTED_CAPABILITY",
    applicantName: "Ada Aksept",
    scheduledAt: "2031-09-20T13:30:00.000Z",
    room: "R-051A",
    campus: "Gløshaugen",
    operation: "confirmInvitation",
    actionLabel: "Bekreft intervjutid",
    finalState: "Accepted",
    stateLabel: "Akseptert",
    responseMessage: null,
  },
  {
    key: "rejected",
    capabilityEnvironment: "INVITATION_RESPONSE_E2E_REJECTED_CAPABILITY",
    applicantName: "Rita Avslag",
    scheduledAt: "2031-09-20T14:30:00.000Z",
    room: "R-051B",
    campus: "Gløshaugen",
    operation: "rejectInvitation",
    actionLabel: "Avvis intervju",
    finalState: "Rejected",
    stateLabel: "Avvist",
    responseMessage: "Jeg kan ikke delta på dette tidspunktet.",
  },
  {
    key: "requested-new-time",
    capabilityEnvironment: "INVITATION_RESPONSE_E2E_REQUESTED_NEW_TIME_CAPABILITY",
    applicantName: "Nora Ny Tid",
    scheduledAt: "2031-09-20T15:30:00.000Z",
    room: "R-051C",
    campus: "Gløshaugen",
    operation: "requestNewInvitationTime",
    actionLabel: "Be om nytt tidspunkt",
    finalState: "RequestedNewTime",
    stateLabel: "Ønsker nytt tidspunkt",
    responseMessage: "Kan vi møtes torsdag i stedet?",
  },
] as const;

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the native invitation-response journey`);
  }
  return value;
};

const containsCapability = (value: string, capabilities: readonly string[]): boolean =>
  capabilities.some((capability) => value.includes(capability));

const assertCapabilityAbsent = (value: unknown, capabilities: readonly string[]): void => {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (containsCapability(serialized, capabilities)) {
    throw new Error("Raw invitation capability entered browser-visible evidence");
  }
};

const bridgeOperation = (request: Request): string | undefined => {
  const pathname = new URL(request.url()).pathname;
  if (request.method() !== "POST" || (pathname !== "/interview" && pathname !== "/recruitment")) {
    return undefined;
  }
  try {
    const payload: unknown = request.postDataJSON();
    return typeof payload === "object" &&
      payload !== null &&
      "operation" in payload &&
      typeof payload.operation === "string"
      ? payload.operation
      : undefined;
  } catch {
    return undefined;
  }
};

type BrowserObservation = {
  readonly bridgeOperations: Array<{ actor: string; operation: string }>;
  readonly capabilityExchanges: Record<string, number>;
  readonly bearerRequests: Array<string>;
  externalRequests: number;
  providerRequests: number;
  legacyRequests: number;
  pageErrors: number;
  consoleErrors: number;
  consoleErrorMessages: Array<string>;
  rawCapabilityLeak: boolean;
};

const observePage = (
  page: Page,
  actor: string,
  expectedExchangeCapability: string | null,
  capabilities: readonly string[],
  observation: BrowserObservation,
): void => {
  page.on("request", (request) => {
    const url = new URL(request.url());
    const pathname = url.pathname;
    const operation = bridgeOperation(request);
    if (operation !== undefined) observation.bridgeOperations.push({ actor, operation });
    if (request.headers().authorization !== undefined) observation.bearerRequests.push(pathname);

    const requestContainsCapability = containsCapability(request.url(), capabilities);
    if (requestContainsCapability) {
      const expectedExchangePath =
        expectedExchangeCapability === null
          ? null
          : `/interview-response/${expectedExchangeCapability}`;
      if (
        expectedExchangePath !== pathname ||
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()
      ) {
        observation.rawCapabilityLeak = true;
      } else {
        observation.capabilityExchanges[actor] = (observation.capabilityExchanges[actor] ?? 0) + 1;
      }
    }
    const postData = request.postData();
    if (postData !== null && containsCapability(postData, capabilities)) {
      observation.rawCapabilityLeak = true;
    }
    const nonCookieHeaders = Object.entries(request.headers())
      .filter(([name]) => name.toLowerCase() !== "cookie")
      .map(([name, value]) => `${name}:${value}`)
      .join("\n");
    if (containsCapability(nonCookieHeaders, capabilities)) {
      observation.rawCapabilityLeak = true;
    }
    if (url.origin !== DASHBOARD_ORIGIN) observation.externalRequests += 1;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      observation.providerRequests += 1;
    }
    if (
      pathname.startsWith("/api/interview-responses") ||
      pathname === "/api/admin/interviews" ||
      pathname.startsWith("/api/admin/interviews/") ||
      pathname.includes("symfony")
    ) {
      observation.legacyRequests += 1;
    }
  });
  page.on("pageerror", (error) => {
    observation.pageErrors += 1;
    if (containsCapability(error.message, capabilities)) observation.rawCapabilityLeak = true;
  });
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() !== "error" ||
      /^Failed to load resource: the server responded with a status of \d+/.test(text)
    )
      return;
    observation.consoleErrors += 1;
    observation.consoleErrorMessages.push(
      containsCapability(text, capabilities) ? "[capability redacted]" : text,
    );
    if (containsCapability(text, capabilities)) observation.rawCapabilityLeak = true;
  });
};

const waitForBridgeResponse = (page: Page, operation: string): Promise<Response> =>
  page.waitForResponse((response) => bridgeOperation(response.request()) === operation);

const readResponseBody = async (
  response: Response,
  capabilities: readonly string[],
): Promise<unknown> => {
  const body = await response.text();
  assertCapabilityAbsent(body, capabilities);
  if (body.length === 0) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("The invitation-response bridge returned malformed JSON");
  }
};

const interactionIdForPage = (page: Page): string => {
  const url = new URL(page.url());
  const parameters = [...url.searchParams.entries()];
  const interactionId = parameters[0]?.[1];
  if (
    url.origin !== DASHBOARD_ORIGIN ||
    url.pathname !== "/interview-response/redacted" ||
    parameters.length !== 1 ||
    parameters[0]?.[0] !== "interactionId" ||
    interactionId === undefined ||
    !INVITATION_INTERACTION_PATTERN.test(interactionId)
  ) {
    throw new Error("Applicant navigation did not expose one strict interaction binding");
  }
  return interactionId;
};

const bridgeFetch = async (
  page: Page,
  payload: Readonly<Record<string, unknown>>,
  capabilities: readonly string[],
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const interactionId = interactionIdForPage(page);
  const result = await page.evaluate(
    async ({ body, interactionId, interactionHeader }) => {
      const response = await fetch("/interview", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          [interactionHeader]: interactionId,
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    },
    {
      body: payload,
      interactionId,
      interactionHeader: INVITATION_INTERACTION_HEADER,
    },
  );
  assertCapabilityAbsent(result.text, capabilities);
  let body: unknown;
  if (result.text.length > 0) {
    try {
      body = JSON.parse(result.text) as unknown;
    } catch {
      throw new Error("The invitation-response bridge returned malformed JSON");
    }
  }
  return { status: result.status, body };
};

const assertObservation = (
  value: unknown,
  responseCase: ApplicantCase,
  responseState: ResponseState,
  responseMessage: string | null,
): void => {
  expect(value).toEqual({
    scheduledAt: responseCase.scheduledAt,
    room: responseCase.room,
    campus: responseCase.campus,
    responseState,
    responseMessage,
  });
};

const authenticate = async (
  page: Page,
  emailEnvironment: string,
  passwordEnvironment: string,
): Promise<ReadonlyArray<string>> => {
  await page.goto("/login");
  await page.getByLabel("E-post").fill(requiredEnvironment(emailEnvironment));
  await page.getByLabel("Passord", { exact: true }).fill(requiredEnvironment(passwordEnvironment));
  await page.getByRole("button", { name: "Logg inn" }).click();
  try {
    await page.waitForURL(/\/dashboard\/?$/, { timeout: 5_000 });
  } catch (error) {
    throw new Error(
      `native login did not redirect: ${page.url()} ${await page.locator("body").innerText()}`,
      { cause: error },
    );
  }
  const sessionCookieNames = (await page.context().cookies(DASHBOARD_ORIGIN))
    .filter(
      ({ name }) =>
        name === "better-auth.session_token" || name === "__Secure-better-auth.session_token",
    )
    .map(({ name }) => name)
    .sort();
  if (sessionCookieNames.length === 0) {
    throw new Error("native login did not issue a Better Auth session cookie");
  }
  return sessionCookieNames;
};

const assertApplicantPrivacy = async (
  context: BrowserContext,
  page: Page,
  expectedCapability: string,
  capabilities: readonly string[],
): Promise<{
  readonly httpOnly: true;
  readonly sameSite: "Strict";
  readonly path: "/interview";
  readonly session: true;
  readonly valueMatchesExchange: true;
  readonly interactionBound: true;
}> => {
  const interactionId = interactionIdForPage(page);
  const [content, bodyText, readableCookie, browserStorage, cookies] = await Promise.all([
    page.content(),
    page.locator("body").innerText(),
    page.evaluate(readDocumentCookie),
    page.evaluate(readBrowserStorage),
    context.cookies(`${DASHBOARD_ORIGIN}/interview`),
  ]);
  assertCapabilityAbsent(page.url(), capabilities);
  assertCapabilityAbsent(content, capabilities);
  assertCapabilityAbsent(bodyText, capabilities);
  assertCapabilityAbsent(readableCookie, capabilities);
  assertCapabilityAbsent(browserStorage, capabilities);

  const expectedCookieName = `${INVITATION_COOKIE_PREFIX}${interactionId}`;
  const invitationCookies = cookies.filter((cookie) =>
    cookie.name.startsWith(INVITATION_COOKIE_PREFIX),
  );
  const invitationCookie = invitationCookies.find((cookie) => cookie.name === expectedCookieName);
  if (
    invitationCookie === undefined ||
    invitationCookie.value !== expectedCapability ||
    invitationCookie.httpOnly !== true ||
    invitationCookie.sameSite !== "Strict" ||
    invitationCookie.path !== "/interview" ||
    invitationCookie.expires !== -1 ||
    invitationCookies.some(
      (cookie) =>
        !INVITATION_INTERACTION_PATTERN.test(cookie.name.slice(INVITATION_COOKIE_PREFIX.length)) ||
        !capabilities.includes(cookie.value) ||
        cookie.httpOnly !== true ||
        cookie.sameSite !== "Strict" ||
        cookie.path !== "/interview" ||
        cookie.expires !== -1,
    ) ||
    new Set(invitationCookies.map((cookie) => cookie.name)).size !== invitationCookies.length
  ) {
    throw new Error("The server-held invitation cookies violated their interaction bindings");
  }
  if (
    cookies.some(
      (cookie) =>
        !cookie.name.startsWith(INVITATION_COOKIE_PREFIX) &&
        containsCapability(cookie.value, capabilities),
    )
  ) {
    throw new Error("A raw invitation capability entered an unrelated browser cookie");
  }
  return {
    httpOnly: true,
    sameSite: "Strict",
    path: "/interview",
    session: true,
    valueMatchesExchange: true,
    interactionBound: true,
  };
};

const waitForDeferred = async (promise: Promise<void>, label: string): Promise<void> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} was not observed`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

const runCommandWithFreshReadGate = async (
  page: Page,
  responseCase: ApplicantCase,
  capabilities: readonly string[],
): Promise<{ readonly commandStatus: 204; readonly freshReadStatus: 200 }> => {
  let resolveReadArrival!: () => void;
  const readArrived = new Promise<void>((resolve) => {
    resolveReadArrival = resolve;
  });
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let routeHandlerStarted = false;
  let resolveRouteHandler!: () => void;
  const routeHandlerCompleted = new Promise<void>((resolve) => {
    resolveRouteHandler = resolve;
  });
  let gateArmed = true;
  const routeHandler = async (route: Route): Promise<void> => {
    routeHandlerStarted = true;
    try {
      if (gateArmed && bridgeOperation(route.request()) === "readInvitationResponse") {
        gateArmed = false;
        resolveReadArrival();
        await readReleased;
      }
      await route.continue();
    } finally {
      resolveRouteHandler();
    }
  };

  await page.route("**/interview", routeHandler);
  const commandResponse = waitForBridgeResponse(page, responseCase.operation);
  try {
    await page.getByRole("button", { name: responseCase.actionLabel, exact: true }).click();
    const command = await commandResponse;
    if (command.status() !== 204) {
      const failure = await readResponseBody(command, capabilities);
      const failureTag =
        failure !== null && typeof failure === "object" && "_tag" in failure
          ? String(failure._tag)
          : "Unknown";
      throw new Error(
        `A valid ${responseCase.key} invitation response returned ${command.status()} ${failureTag}`,
      );
    }
    const contentLength = command.headers()["content-length"];
    if (contentLength !== undefined && contentLength !== "0") {
      throw new Error("A successful invitation response command returned interface data");
    }
    await waitForDeferred(readArrived, "Post-command applicant read");
    if ((await page.getByText(responseCase.stateLabel, { exact: true }).count()) !== 0) {
      throw new Error("The applicant interface changed before its fresh server read");
    }
    const freshReadResponse = waitForBridgeResponse(page, "readInvitationResponse");
    releaseRead();
    const read = await freshReadResponse;
    if (read.status() !== 200) throw new Error("The post-command applicant read did not succeed");
    const observation = await readResponseBody(read, capabilities);
    assertObservation(
      observation,
      responseCase,
      responseCase.finalState,
      responseCase.responseMessage,
    );
    return { commandStatus: 204, freshReadStatus: 200 };
  } finally {
    releaseRead();
    if (routeHandlerStarted) await routeHandlerCompleted;
    await page.unroute("**/interview", routeHandler);
  }
};

const applicantCard = (page: Page, applicantName: string) =>
  page.getByRole("article").filter({ hasText: applicantName });

const assertNoObservedFailures = (observation: BrowserObservation): void => {
  if (
    observation.externalRequests !== 0 ||
    observation.providerRequests !== 0 ||
    observation.legacyRequests !== 0 ||
    observation.bearerRequests.length !== 0 ||
    observation.pageErrors !== 0 ||
    observation.consoleErrors !== 0 ||
    observation.rawCapabilityLeak
  ) {
    throw new Error(
      `The browser observed failures: external=${observation.externalRequests}, provider=${observation.providerRequests}, legacy=${observation.legacyRequests}, bearer=${observation.bearerRequests.length}, page=${observation.pageErrors}, console=${observation.consoleErrors}, capability=${String(observation.rawCapabilityLeak)}, consoleMessages=${JSON.stringify(observation.consoleErrorMessages)}`,
    );
  }
};

test.describe("Native recruitment invitation response", () => {
  test.describe.configure({ retries: 0, mode: "serial" });
  test.skip(
    !REAL_NATIVE_INVITATION_RESPONSE_E2E,
    "run through the disposable native invitation-response runner",
  );

  test("responds through native authority and refreshes independent staff projections", async ({
    browser,
  }) => {
    const evidencePath = requiredEnvironment("INVITATION_RESPONSE_E2E_BROWSER_EVIDENCE_PATH");
    const capabilitiesByCase = Object.fromEntries(
      APPLICANT_CASES.map((responseCase) => [
        responseCase.key,
        requiredEnvironment(responseCase.capabilityEnvironment),
      ]),
    ) as Record<ApplicantCase["key"], string>;
    const capabilities = Object.values(capabilitiesByCase);
    if (
      capabilities.length !== 3 ||
      new Set(capabilities).size !== 3 ||
      capabilities.some((capability) => !/^[A-Za-z0-9_-]{43}$/.test(capability))
    ) {
      throw new Error("The runner did not provide three distinct canonical capabilities");
    }

    const observation: BrowserObservation = {
      bridgeOperations: [],
      capabilityExchanges: {},
      bearerRequests: [],
      externalRequests: 0,
      providerRequests: 0,
      legacyRequests: 0,
      pageErrors: 0,
      consoleErrors: 0,
      consoleErrorMessages: [],
      rawCapabilityLeak: false,
    };
    const applicantEvidence: Array<Record<string, unknown>> = [];
    const applicantGroups: ReadonlyArray<ReadonlyArray<ApplicantCase>> = [
      APPLICANT_CASES.filter(({ key }) => key !== "requested-new-time"),
      APPLICANT_CASES.filter(({ key }) => key === "requested-new-time"),
    ];
    let applicantContextsClosed = 0;
    let tabBindingEvidence: Record<string, unknown> | null = null;
    let accessibilityRuns = 0;

    for (const responseCases of applicantGroups) {
      const context = await browser.newContext({
        baseURL: DASHBOARD_ORIGIN,
        viewport: { width: 1440, height: 900 },
      });
      try {
        const tabs: Array<{
          readonly responseCase: ApplicantCase;
          readonly capability: string;
          readonly page: Page;
        }> = [];
        for (const responseCase of responseCases) {
          const capability = capabilitiesByCase[responseCase.key];
          const page = await context.newPage();
          const actor = `Applicant:${responseCase.key}`;
          observePage(page, actor, capability, capabilities, observation);
          const initialReadResponse = waitForBridgeResponse(page, "readInvitationResponse");
          await page.goto(`/interview-response/${capability}`);
          const initialRead = await initialReadResponse;
          if (initialRead.status() !== 200) {
            throw new Error("Initial applicant read did not succeed");
          }
          assertObservation(
            await readResponseBody(initialRead, capabilities),
            responseCase,
            "Pending",
            null,
          );
          interactionIdForPage(page);
          await expect(
            page.getByRole("heading", { name: "Svar på intervjutid", exact: true }),
          ).toBeVisible();
          await expect(page.getByText(responseCase.room, { exact: true })).toBeVisible();
          await expect(page.getByText(responseCase.campus, { exact: true })).toBeVisible();
          await expect(page.getByText("Venter på svar", { exact: true })).toBeVisible();
          tabs.push({ responseCase, capability, page });
        }

        if (tabs.length === 2) {
          const interactionIds = tabs.map(({ page }) => interactionIdForPage(page));
          if (new Set(interactionIds).size !== interactionIds.length) {
            throw new Error("Two invitation tabs received the same interaction id");
          }
          const expectedCookieNames = interactionIds
            .map((interactionId) => `${INVITATION_COOKIE_PREFIX}${interactionId}`)
            .sort();
          const cookieNamesBeforeInvalidExchange = (
            await context.cookies(`${DASHBOARD_ORIGIN}/interview`)
          )
            .filter((cookie) => cookie.name.startsWith(INVITATION_COOKIE_PREFIX))
            .map((cookie) => cookie.name)
            .sort();
          if (
            JSON.stringify(cookieNamesBeforeInvalidExchange) !== JSON.stringify(expectedCookieNames)
          ) {
            throw new Error("Two invitation tabs did not retain distinct capability cookies");
          }

          const invalidPage = await context.newPage();
          observePage(invalidPage, "Applicant:invalid-exchange", null, capabilities, observation);
          const invalidExchangeResponse = await invalidPage.goto("/interview-response/invalid");
          if (
            invalidExchangeResponse?.status() !== 404 ||
            new URL(invalidPage.url()).pathname !== "/interview-response/redacted"
          ) {
            throw new Error("Invalid invitation exchange did not fail on the redacted route");
          }
          await invalidPage.close();

          const cookieNamesAfterInvalidExchange = (
            await context.cookies(`${DASHBOARD_ORIGIN}/interview`)
          )
            .filter((cookie) => cookie.name.startsWith(INVITATION_COOKIE_PREFIX))
            .map((cookie) => cookie.name)
            .sort();
          if (
            JSON.stringify(cookieNamesAfterInvalidExchange) !==
            JSON.stringify(cookieNamesBeforeInvalidExchange)
          ) {
            throw new Error("Invalid invitation exchange erased another tab binding");
          }
          tabBindingEvidence = {
            sameBrowserContext: true,
            exchangedTabs: 2,
            distinctInteractionIds: true,
            distinctCookieNames: true,
            invalidExchangeStatus: 404,
            invalidExchangePreservedBindings: true,
          };
        }

        for (const { responseCase, capability, page } of tabs) {
          const cookieEvidence = await assertApplicantPrivacy(
            context,
            page,
            capability,
            capabilities,
          );

          let invalidBlankEvidence: Record<string, unknown> | null = null;
          let capabilityShapedMessageEvidence: Record<string, unknown> | null = null;
          if (responseCase.key === "requested-new-time") {
            const operationsBeforeClientValidation = observation.bridgeOperations.length;
            await page.getByRole("button", { name: responseCase.actionLabel, exact: true }).click();
            await expect(
              page.getByRole("alert").filter({
                hasText: "Skriv en melding før du ber om nytt tidspunkt.",
              }),
            ).toBeVisible();
            await page.waitForTimeout(100);
            if (observation.bridgeOperations.length !== operationsBeforeClientValidation) {
              throw new Error("Blank new-time input crossed the Foldkit command boundary");
            }
            await expect(page.getByText("Venter på svar", { exact: true })).toBeVisible();

            await page
              .getByLabel("Melding", { exact: true })
              .fill(`Flytt intervjuet ${capabilitiesByCase.accepted} takk`);
            const operationsBeforeCapabilityMessage = observation.bridgeOperations.length;
            await page.getByRole("button", { name: responseCase.actionLabel, exact: true }).click();
            await expect(
              page.getByRole("alert").filter({
                hasText: "Meldingen inneholder innhold som ikke er tillatt.",
              }),
            ).toBeVisible();
            await page.waitForTimeout(100);
            if (observation.bridgeOperations.length !== operationsBeforeCapabilityMessage) {
              throw new Error("Capability-shaped input crossed the Foldkit command boundary");
            }
            await expect(page.getByText("Venter på svar", { exact: true })).toBeVisible();
            capabilityShapedMessageEvidence = {
              clientCommandBlocked: true,
              bridgeFetchAttempted: false,
              preservedState: "Pending",
            };

            const invalid = await bridgeFetch(
              page,
              { operation: "requestNewInvitationTime", message: "   " },
              capabilities,
            );
            if (
              invalid.status !== 422 ||
              typeof invalid.body !== "object" ||
              invalid.body === null ||
              !("_tag" in invalid.body) ||
              invalid.body._tag !== "InvitationDecodeError"
            ) {
              throw new Error("The strict bridge did not reject blank new-time input");
            }
            const preserved = await bridgeFetch(
              page,
              { operation: "readInvitationResponse" },
              capabilities,
            );
            if (preserved.status !== 200) {
              throw new Error("Invalid response preservation read failed");
            }
            assertObservation(preserved.body, responseCase, "Pending", null);
            const pendingAccessibility = await new AxeBuilder({ page })
              .include("main.foldkit-interview")
              .analyze();
            if (pendingAccessibility.violations.length !== 0) {
              throw new Error("Applicant pending validation state has accessibility violations");
            }
            accessibilityRuns += 1;
            invalidBlankEvidence = {
              clientCommandBlocked: true,
              bridgeStatus: 422,
              freshReadStatus: 200,
              preservedState: "Pending",
            };
          }

          if (responseCase.responseMessage !== null) {
            await page.getByLabel("Melding", { exact: true }).fill(responseCase.responseMessage);
          }
          const commandEvidence = await runCommandWithFreshReadGate(
            page,
            responseCase,
            capabilities,
          );
          await expect(page.getByText(responseCase.stateLabel, { exact: true })).toBeVisible();
          if (responseCase.responseMessage !== null) {
            await expect(
              page.getByText(responseCase.responseMessage, { exact: true }),
            ).toBeVisible();
          }

          const repeated = await bridgeFetch(
            page,
            responseCase.responseMessage === null
              ? { operation: responseCase.operation }
              : {
                  operation: responseCase.operation,
                  message: responseCase.responseMessage,
                },
            capabilities,
          );
          if (
            repeated.status !== 409 ||
            typeof repeated.body !== "object" ||
            repeated.body === null ||
            !("_tag" in repeated.body) ||
            repeated.body._tag !== "InvitationAlreadyResponded"
          ) {
            throw new Error("A repeated invitation response did not return the typed conflict");
          }
          const repeatedRead = await bridgeFetch(
            page,
            { operation: "readInvitationResponse" },
            capabilities,
          );
          if (repeatedRead.status !== 200) {
            throw new Error("Repeated response preservation read failed");
          }
          assertObservation(
            repeatedRead.body,
            responseCase,
            responseCase.finalState,
            responseCase.responseMessage,
          );
          await expect(page.getByText(responseCase.stateLabel, { exact: true })).toBeVisible();
          await assertApplicantPrivacy(context, page, capability, capabilities);

          const accessibility = await new AxeBuilder({ page })
            .include("main.foldkit-interview")
            .analyze();
          if (accessibility.violations.length !== 0) {
            throw new Error("Applicant response state has accessibility violations");
          }
          accessibilityRuns += 1;
          applicantEvidence.push({
            key: responseCase.key,
            applicantName: responseCase.applicantName,
            initialReadStatus: 200,
            initialState: "Pending",
            commandStatus: commandEvidence.commandStatus,
            commandResultUsedAsObservation: false,
            freshReadStatus: commandEvidence.freshReadStatus,
            finalState: responseCase.finalState,
            responseMessage: responseCase.responseMessage,
            repeatedStatus: 409,
            repeatedFreshReadStatus: 200,
            repeatedState: responseCase.finalState,
            scheduleRetained: true,
            invalidBlank: invalidBlankEvidence,
            capabilityShapedMessage: capabilityShapedMessageEvidence,
            cookie: cookieEvidence,
            redactedUrl: true,
          });
        }
      } finally {
        await context.close();
        applicantContextsClosed += 1;
      }
    }

    const staffEvidence: Record<string, unknown> = {};
    let staffContextsClosed = 0;
    for (const staffCase of [
      {
        actor: "DepartmentLeader",
        email: "INVITATION_RESPONSE_E2E_LEADER_EMAIL",
        password: "INVITATION_RESPONSE_E2E_LEADER_PASSWORD",
      },
      {
        actor: "Member",
        email: "INVITATION_RESPONSE_E2E_MEMBER_EMAIL",
        password: "INVITATION_RESPONSE_E2E_MEMBER_PASSWORD",
      },
    ] as const) {
      const context = await browser.newContext({
        baseURL: DASHBOARD_ORIGIN,
        viewport: { width: 1440, height: 900 },
      });
      try {
        const page = await context.newPage();
        const sessionCookieNames = await authenticate(page, staffCase.email, staffCase.password);
        if (JSON.stringify(sessionCookieNames) !== JSON.stringify(["better-auth.session_token"])) {
          throw new Error("Native login issued an unexpected Better Auth session cookie");
        }
        observePage(page, staffCase.actor, null, capabilities, observation);
        await page.goto("/dashboard/intervjuer");
        await expect(
          page.getByRole("heading", { level: 1, name: "Planlegg intervjuer" }),
        ).toBeVisible({ timeout: 30_000 });
        const freshBoardResponse = page.waitForResponse(
          (response) => bridgeOperation(response.request()) === "readSchedulingBoard",
        );
        await page.getByRole("button", { name: "Hent oppdatert oversikt", exact: true }).click();
        const boardResponse = await freshBoardResponse;
        if (boardResponse.status() !== 200)
          throw new Error("Fresh staff board read did not succeed");
        await readResponseBody(boardResponse, capabilities);

        for (const responseCase of APPLICANT_CASES) {
          const card = applicantCard(page, responseCase.applicantName);
          if (staffCase.actor === "Member" && responseCase.finalState === "Rejected") {
            await expect(card).toHaveCount(0);
            continue;
          }
          await expect(card).toHaveCount(1);
          await expect(card).toContainText(responseCase.room);
          await expect(card).toContainText(responseCase.stateLabel);
          if (responseCase.responseMessage === null) {
            await expect(card).not.toContainText("Melding fra søker");
          } else {
            await expect(card).toContainText("Melding fra søker");
            await expect(card).toContainText(responseCase.responseMessage);
          }
        }
        const accessibility = await new AxeBuilder({ page })
          .include('section[aria-labelledby="fs-page-title"]')
          .analyze();
        if (accessibility.violations.length !== 0) {
          throw new Error("Staff scheduling board has accessibility violations");
        }
        accessibilityRuns += 1;
        assertCapabilityAbsent(await page.locator("body").innerText(), capabilities);
        staffEvidence[staffCase.actor] = {
          freshReadStatus: 200,
          sessionCookieNames,
          nativeLogin: true,
          acceptedVisible: true,
          rejectedVisible: staffCase.actor === "DepartmentLeader",
          requestedNewTimeVisible: true,
          responseMessagesProjected: true,
        };
      } finally {
        await context.close();
        staffContextsClosed += 1;
      }
    }

    const expectedBridgeOperations = [
      { actor: "Applicant:accepted", operation: "readInvitationResponse" },
      { actor: "Applicant:rejected", operation: "readInvitationResponse" },
      { actor: "Applicant:accepted", operation: "confirmInvitation" },
      { actor: "Applicant:accepted", operation: "readInvitationResponse" },
      { actor: "Applicant:accepted", operation: "confirmInvitation" },
      { actor: "Applicant:accepted", operation: "readInvitationResponse" },
      { actor: "Applicant:rejected", operation: "rejectInvitation" },
      { actor: "Applicant:rejected", operation: "readInvitationResponse" },
      { actor: "Applicant:rejected", operation: "rejectInvitation" },
      { actor: "Applicant:rejected", operation: "readInvitationResponse" },
      { actor: "Applicant:requested-new-time", operation: "readInvitationResponse" },
      { actor: "Applicant:requested-new-time", operation: "requestNewInvitationTime" },
      { actor: "Applicant:requested-new-time", operation: "readInvitationResponse" },
      { actor: "Applicant:requested-new-time", operation: "requestNewInvitationTime" },
      { actor: "Applicant:requested-new-time", operation: "readInvitationResponse" },
      { actor: "Applicant:requested-new-time", operation: "requestNewInvitationTime" },
      { actor: "Applicant:requested-new-time", operation: "readInvitationResponse" },
      { actor: "DepartmentLeader", operation: "readSchedulingBoard" },
      { actor: "Member", operation: "readSchedulingBoard" },
    ];
    expect(observation.bridgeOperations).toEqual(expectedBridgeOperations);
    expect(observation.capabilityExchanges).toEqual({
      "Applicant:accepted": 1,
      "Applicant:rejected": 1,
      "Applicant:requested-new-time": 1,
    });
    if (applicantContextsClosed !== 2 || staffContextsClosed !== 2 || tabBindingEvidence === null) {
      throw new Error("Browser contexts or shared invitation tab evidence were incomplete");
    }
    assertNoObservedFailures(observation);

    const evidence = {
      topology: "native-postgresql-foldkit-chromium",
      applicantContexts: {
        isolatedFromStaff: true,
        sharedTabContext: true,
        closed: applicantContextsClosed,
      },
      tabBinding: tabBindingEvidence,
      applicantCases: applicantEvidence,
      staffContexts: {
        independent: true,
        closed: staffContextsClosed,
        observations: staffEvidence,
      },
      bridgeOperations: observation.bridgeOperations,
      bearerRequests: observation.bearerRequests,
      capabilityExchangeRequests: 3,
      operationOrderingConfirmed: true,
      accessibilityRuns,
      accessibilityViolations: 0,
      legacyBrowserRequests: observation.legacyRequests,
      externalBrowserRequests: observation.externalRequests,
      providerBrowserRequests: observation.providerRequests,
      pageErrors: observation.pageErrors,
      consoleErrors: observation.consoleErrors,
      rawCapabilityObservedOutsideExchange: false,
      rawCapabilitySerialized: false,
    };
    const serializedEvidence = `${JSON.stringify(evidence)}\n`;
    assertCapabilityAbsent(serializedEvidence, capabilities);
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, serializedEvidence, "utf8");
  });
});
