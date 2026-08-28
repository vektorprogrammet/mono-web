import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEFAULT_RECEIPT_COMPOSE_FILE = join(REPOSITORY_ROOT, "docker-compose.yml");
const RECEIPT_COMPOSE_FILE = process.env.RECEIPT_COMPOSE_FILE ?? DEFAULT_RECEIPT_COMPOSE_FILE;
const RECEIPT_COMPOSE_PROJECT = process.env.RECEIPT_COMPOSE_PROJECT;
const RECEIPT_POSTGRES_TOPOLOGY = process.env.RECEIPT_POSTGRES_TOPOLOGY ?? "docker";
const RECEIPT_POSTGRES_PACKAGE = process.env.RECEIPT_POSTGRES_PACKAGE ?? "nixpkgs#postgresql_17";
const RECEIPT_PG_DATA_ROOT = process.env.RECEIPT_PG_DATA_ROOT;
const RECEIPT_PG_PORT = process.env.RECEIPT_PG_PORT ?? "55432";
const RECEIPT_APPROVAL_EVIDENCE_FILE = process.env.RECEIPT_APPROVAL_EVIDENCE_FILE;
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5174";
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8790";
const REAL_RECEIPT_APPROVAL_E2E = process.env.REAL_RECEIPT_APPROVAL_E2E === "1";
const RECEIPT_DATE = "2026-08-22";
const RECEIPT_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const receiptStatusSchema = z.enum(["Pending", "Refunded", "Rejected", "Withdrawn"]);

const receiptErrorSchema = z
  .object({
    error: z
      .object({
        tag: z.string(),
      })
      .strict(),
  })
  .strict();

const receiptObservationSchema = z
  .object({
    commandId: z.string().min(1),
    receiptId: z.string().min(1),
    visualId: z.string().min(1),
    status: receiptStatusSchema,
    revision: z.number().int().nonnegative(),
    replayed: z.boolean(),
  })
  .strict();

const receiptProjectionSchema = z
  .object({
    receiptId: z.string().min(1),
    visualId: z.string().min(1),
    ownerPersonId: z.string().min(1),
    departmentId: z.string().min(1),
    description: z.string().min(1),
    amountOre: z.number().int().positive(),
    currency: z.literal("NOK"),
    receiptDate: z.string(),
    status: receiptStatusSchema,
    revision: z.number().int().nonnegative(),
  })
  .strict();

const receiptPageSchema = z
  .object({
    items: z.array(receiptProjectionSchema),
    totalItems: z.number().int().nonnegative(),
  })
  .strict();

const fileIdentitySchema = z.array(
  z
    .object({
      receiptId: z.string().min(1),
      fileRef: z.string().min(1),
      objectKey: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
);

type ReceiptProjection = z.infer<typeof receiptProjectionSchema>;
type ReceiptStatus = z.infer<typeof receiptStatusSchema>;
type ResolutionIntent = "refund" | "reject";
type FileIdentity = z.infer<typeof fileIdentitySchema>[number];

type PersonaEnvironment = {
  readonly fixtureLabel: string;
  readonly email: string;
  readonly password: string;
  readonly personId: string;
};

type ApprovalEnvironment = {
  readonly ownerA: PersonaEnvironment;
  readonly ownerB: PersonaEnvironment;
  readonly departmentA: PersonaEnvironment;
  readonly departmentB: PersonaEnvironment;
  readonly global: PersonaEnvironment;
  readonly inactive: PersonaEnvironment;
  readonly noneScope: PersonaEnvironment;
};

type AuthenticatedPersona = {
  readonly cookie: string;
  readonly browserCookie: {
    readonly name: string;
    readonly value: string;
    readonly url: string;
    readonly httpOnly: boolean;
    readonly sameSite: "Lax";
  };
  readonly fixtureLabel: string;
  readonly sessionCookieNames: ReadonlyArray<string>;
  readonly sessionPersonId: string;
};

type SubmittedReceipt = {
  projection: ReceiptProjection;
  submissionCommandId: string;
};

const JOURNEY_REF_ID = "intent://journey:parity:finance_operations:v1";
const ACCEPTED_STEP_IDS = [
  "finance-operations-api-operation",
  "finance-operations-command-write",
  "finance-operations-legacy-route",
  "finance-operations-mono-route",
] as const;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the real Receipt approval journey`);
  }
  return value;
}

function personaEnvironment(prefix: string, fixtureLabel: string): PersonaEnvironment {
  return {
    fixtureLabel,
    email: requiredEnvironment(`${prefix}_EMAIL`),
    password: requiredEnvironment(`${prefix}_PASSWORD`),
    personId: requiredEnvironment(`${prefix}_PERSON_ID`),
  };
}

function approvalEnvironment(): ApprovalEnvironment {
  if (process.env.REAL_RECEIPT_OWNER_E2E !== "1") {
    throw new Error(
      "REAL_RECEIPT_OWNER_E2E=1 is required with REAL_RECEIPT_APPROVAL_E2E=1 so Playwright uses the externally started disposable topology",
    );
  }

  return {
    ownerA: personaEnvironment(
      "RECEIPT_APPROVAL_E2E_OWNER_A",
      "owner-a-department-a-payment-authority",
    ),
    ownerB: personaEnvironment(
      "RECEIPT_APPROVAL_E2E_OWNER_B",
      "owner-b-department-b-payment-authority",
    ),
    departmentA: personaEnvironment(
      "RECEIPT_APPROVAL_E2E_DEPARTMENT_A",
      "approver-a-active-department-a-grant",
    ),
    departmentB: personaEnvironment(
      "RECEIPT_APPROVAL_E2E_DEPARTMENT_B",
      "approver-b-active-department-b-grant",
    ),
    global: personaEnvironment(
      "RECEIPT_APPROVAL_E2E_GLOBAL",
      "approver-global-active-global-receipt-grant",
    ),
    inactive: personaEnvironment(
      "RECEIPT_APPROVAL_E2E_INACTIVE",
      "approver-inactive-ended-department-a-membership",
    ),
    noneScope: personaEnvironment(
      "RECEIPT_APPROVAL_E2E_NONE_SCOPE",
      "approver-none-active-without-receipt-grant",
    ),
  };
}

function sessionHeaders(cookie: string): { Cookie: string } {
  return { Cookie: cookie };
}

async function responseErrorTag(response: APIResponse): Promise<string> {
  return receiptErrorSchema.parse(await response.json()).error.tag;
}
const fileIdentitySql = `
  SELECT COALESCE(
    json_agg(
      json_build_object(
        'receiptId', receipt_id,
        'fileRef', file_ref,
        'objectKey', file_object_key,
        'sha256', file_sha256
      )
      ORDER BY receipt_id
    ),
    '[]'::json
  )::text
  FROM economy_receipts;
`;

async function readPostgresJson<T>(sql: string): Promise<T> {
  let command: string;
  let commandArgs: Array<string>;
  if (RECEIPT_POSTGRES_TOPOLOGY === "local") {
    if (RECEIPT_PG_DATA_ROOT === undefined || RECEIPT_PG_DATA_ROOT.length === 0) {
      throw new Error("RECEIPT_PG_DATA_ROOT is required for local PostgreSQL evidence");
    }
    command = "nix";
    commandArgs = [
      "shell",
      RECEIPT_POSTGRES_PACKAGE,
      "--command",
      "psql",
      "-h",
      "127.0.0.1",
      "-p",
      RECEIPT_PG_PORT,
      "-U",
      "receipt",
      "-d",
      "receipt_proof",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ];
  } else {
    if (RECEIPT_COMPOSE_PROJECT === undefined || RECEIPT_COMPOSE_PROJECT.length === 0) {
      throw new Error("RECEIPT_COMPOSE_PROJECT is required for durable Receipt evidence");
    }
    command = "docker";
    commandArgs = [
      "compose",
      "-f",
      RECEIPT_COMPOSE_FILE,
      "-p",
      RECEIPT_COMPOSE_PROJECT,
      "exec",
      "-T",
      "receipt-postgres",
      "psql",
      "-U",
      "receipt",
      "-d",
      "receipt_proof",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      sql,
    ];
  }
  const result = await execFileAsync(command, commandArgs, {
    cwd: REPOSITORY_ROOT,
    maxBuffer: 1_048_576,
  });
  const output = String(result.stdout).trim();
  if (output.length === 0) throw new Error("PostgreSQL evidence query returned no JSON");
  const lastLine = output.split(/\r?\n/).at(-1);
  if (lastLine === undefined) throw new Error("PostgreSQL evidence query returned no JSON row");
  return JSON.parse(lastLine) as T;
}

async function readFileIdentities(): Promise<ReadonlyArray<FileIdentity>> {
  return fileIdentitySchema.parse(await readPostgresJson<unknown>(fileIdentitySql));
}

async function observeDurablePostgresFailure(
  request: APIRequestContext,
  cookie: string,
): Promise<{ readonly status: number; readonly tag: string }> {
  await readPostgresJson<boolean>(
    "ALTER TABLE economy_receipts RENAME TO economy_receipts_failure_probe; SELECT 'true'::json::text;",
  );
  let failure: { readonly status: number; readonly tag: string } | undefined;
  try {
    const response = await request.get(`${BACKEND_ORIGIN}/api/admin/receipts`, {
      headers: sessionHeaders(cookie),
      timeout: 5_000,
    });
    failure = { status: response.status(), tag: await responseErrorTag(response) };
  } finally {
    await readPostgresJson<boolean>(
      "ALTER TABLE economy_receipts_failure_probe RENAME TO economy_receipts; SELECT 'true'::json::text;",
    );
  }
  if (failure === undefined) {
    throw new Error("PostgreSQL table failure did not produce a typed durable failure");
  }
  expect(failure.status).toBe(503);
  expect(failure.tag).toBe("ReceiptPersistenceError");
  return failure;
}

async function submitReceipt(
  request: APIRequestContext,
  cookie: string,
  description: string,
  amountOre: number,
): Promise<SubmittedReceipt> {
  const submissionCommandId = randomUUID();
  const response = await request.post(`${BACKEND_ORIGIN}/api/receipts/submit`, {
    headers: sessionHeaders(cookie),
    multipart: {
      commandId: submissionCommandId,
      description,
      amountOre: String(amountOre),
      receiptDate: RECEIPT_DATE,
      file: {
        name: "receipt.png",
        mimeType: "image/png",
        buffer: RECEIPT_BYTES,
      },
    },
  });
  expect([200, 201]).toContain(response.status());
  const observation = receiptObservationSchema.parse(await response.json());
  expect(observation).toMatchObject({
    commandId: submissionCommandId,
    status: "Pending",
    revision: 0,
    replayed: false,
  });

  const ownedResponse = await request.get(`${BACKEND_ORIGIN}/api/receipts`, {
    headers: sessionHeaders(cookie),
  });
  expect(ownedResponse.status()).toBe(200);
  const owned = receiptPageSchema.parse(await ownedResponse.json());
  const projection = owned.items.find((item) => item.receiptId === observation.receiptId);
  if (projection === undefined) {
    throw new Error(
      `Submitted Receipt ${observation.receiptId} is absent from its owner projection`,
    );
  }

  return { projection, submissionCommandId };
}

async function listForApproval(
  request: APIRequestContext,
  cookie: string,
  status?: ReceiptStatus,
): Promise<z.infer<typeof receiptPageSchema>> {
  const query = status === undefined ? "" : `?status=${encodeURIComponent(status)}`;
  const response = await request.get(`${BACKEND_ORIGIN}/api/admin/receipts${query}`, {
    headers: sessionHeaders(cookie),
  });
  expect(response.status()).toBe(200);
  return receiptPageSchema.parse(await response.json());
}

async function authenticate(
  page: Page,
  request: APIRequestContext,
  persona: PersonaEnvironment,
): Promise<AuthenticatedPersona> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("E-post").fill(persona.email);
  await page.getByLabel("Passord", { exact: true }).fill(persona.password);
  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  try {
    await page.waitForURL((url) => url.pathname === "/dashboard", {
      timeout: 15_000,
      waitUntil: "commit",
    });
  } catch (cause) {
    throw new Error(
      `native login for ${persona.personId} did not reach /dashboard; current URL ${page.url()}`,
      { cause },
    );
  }

  const sessionCookies = (await page.context().cookies(DASHBOARD_ORIGIN))
    .filter(
      ({ name }) =>
        name === "better-auth.session_token" || name === "__Secure-better-auth.session_token",
    )
    .sort(({ name: left }, { name: right }) => left.localeCompare(right));
  expect(sessionCookies).toHaveLength(1);
  const sessionCookie = sessionCookies[0];
  if (sessionCookie === undefined) throw new Error("Better Auth session cookie is missing");
  const cookie = `${sessionCookie.name}=${sessionCookie.value}`;
  const sessionResponse = await request.get(`${BACKEND_ORIGIN}/api/me/session`, {
    headers: sessionHeaders(cookie),
  });
  expect(sessionResponse.status()).toBe(200);
  const session = z
    .object({ personId: z.string() })
    .passthrough()
    .parse(await sessionResponse.json());
  expect(session.personId).toBe(persona.personId);

  return {
    cookie,
    browserCookie: {
      name: sessionCookie.name,
      value: sessionCookie.value,
      url: DASHBOARD_ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    },
    fixtureLabel: persona.fixtureLabel,
    sessionCookieNames: [sessionCookie.name],
    sessionPersonId: session.personId,
  };
}

async function usePersona(page: Page, persona: AuthenticatedPersona): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([persona.browserCookie]);
}

async function expectUnauthenticatedBrowser(browser: Browser): Promise<void> {
  const missingContext = await browser.newContext({ baseURL: DASHBOARD_ORIGIN });
  try {
    const missingPage = await missingContext.newPage();
    await missingPage.goto("/dashboard/utlegg");
    await expect(missingPage).toHaveURL(/\/login$/);
  } finally {
    await missingContext.close();
  }

  const invalidContext = await browser.newContext({ baseURL: DASHBOARD_ORIGIN });
  try {
    await invalidContext.addCookies([
      {
        name: "better-auth.session_token",
        value: "invalid-local-receipt-approval-session",
        url: DASHBOARD_ORIGIN,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const invalidPage = await invalidContext.newPage();
    await invalidPage.goto("/dashboard/utlegg");
    await expect(invalidPage).toHaveURL(/\/login\?expired=true$/);
  } finally {
    await invalidContext.close();
  }
}

function receiptRowFor(page: Page, receiptId: string): Locator {
  return page.locator(`tr[data-receipt-id=${JSON.stringify(receiptId)}]`);
}

async function expectNoResolutionControls(row: Locator): Promise<void> {
  await expect(row.getByRole("button", { name: "Refunder", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Avvis", exact: true })).toHaveCount(0);
  await expect(row.locator('[data-terminal="true"]')).toHaveText("Ferdigbehandlet");
}

async function resolveThroughUi(
  page: Page,
  receiptId: string,
  intent: ResolutionIntent,
): Promise<string> {
  const row = receiptRowFor(page, receiptId);
  const trigger = intent === "refund" ? "Refunder" : "Avvis";
  const confirmation = intent === "refund" ? "Bekreft refusjon" : "Bekreft avvisning";
  await row.getByRole("button", { name: trigger, exact: true }).click();

  const form = page.locator(`form[data-receipt-resolution=${JSON.stringify(intent)}]`);
  await expect(form).toBeVisible();
  await expect(form.locator('input[name="receiptId"]')).toHaveValue(receiptId);
  await expect(form.locator('input[name="expectedRevision"]')).toHaveValue("0");
  const commandId = await form.locator('input[name="commandId"]').inputValue();
  expect(commandId).not.toBe("");

  await form.getByRole("button", { name: confirmation, exact: true }).click();
  const notice = page.locator(`[role="status"][data-action-intent=${JSON.stringify(intent)}]`);
  await expect(notice).toHaveAttribute("data-command-id", commandId);
  await expect(notice).toHaveAttribute("data-receipt-id", receiptId);
  await expect(notice).toHaveAttribute("data-revision", "1");
  await expect(notice).toHaveAttribute("data-replayed", "false");

  return commandId;
}

test.describe("Native scoped Receipt approval journey", () => {
  test.skip(!REAL_RECEIPT_APPROVAL_E2E, "requires the disposable native Receipt approval topology");
  test.setTimeout(120_000);

  test("scopes projection and enforces refund, reject, replay, concurrency, and terminal laws", async ({
    browser,
    page,
    request,
  }) => {
    const environment = approvalEnvironment();
    const browserRequestLedger: Array<{
      method: string;
      origin: string;
      pathname: string;
      query: string;
    }> = [];
    page.on("request", (browserRequest) => {
      const url = new URL(browserRequest.url());
      browserRequestLedger.push({
        method: browserRequest.method(),
        origin: url.origin,
        pathname: url.pathname,
        query: url.search,
      });
    });
    const unauthenticatedResponse = await request.get(`${BACKEND_ORIGIN}/api/admin/receipts`);
    expect(unauthenticatedResponse.status()).toBe(401);
    const unauthenticatedTag = await responseErrorTag(unauthenticatedResponse);
    expect(unauthenticatedTag).toBe("UnauthenticatedActor");
    await expectUnauthenticatedBrowser(browser);

    const expiredApiResponse = await request.get(`${BACKEND_ORIGIN}/api/admin/receipts`, {
      headers: sessionHeaders("better-auth.session_token=invalid-local-receipt-approval-session"),
    });
    expect(expiredApiResponse.status()).toBe(401);
    const expiredApiTag = await responseErrorTag(expiredApiResponse);
    expect(expiredApiTag).toBe("UnauthenticatedActor");

    const sessions = {
      ownerA: await authenticate(page, request, environment.ownerA),
      ownerB: await authenticate(page, request, environment.ownerB),
      departmentA: await authenticate(page, request, environment.departmentA),
      departmentB: await authenticate(page, request, environment.departmentB),
      global: await authenticate(page, request, environment.global),
      inactive: await authenticate(page, request, environment.inactive),
      noneScope: await authenticate(page, request, environment.noneScope),
    };

    const inactiveResponse = await request.get(`${BACKEND_ORIGIN}/api/admin/receipts`, {
      headers: sessionHeaders(sessions.inactive.cookie),
    });
    expect(inactiveResponse.status()).toBe(403);
    const inactiveTag = await responseErrorTag(inactiveResponse);
    expect(inactiveTag).toBe("InactiveActor");

    const noneScopeResponse = await request.get(`${BACKEND_ORIGIN}/api/admin/receipts`, {
      headers: sessionHeaders(sessions.noneScope.cookie),
    });
    expect(noneScopeResponse.status()).toBe(403);
    const noneScopeTag = await responseErrorTag(noneScopeResponse);
    expect(noneScopeTag).toBe("ReceiptScopeDenied");

    await usePersona(page, sessions.noneScope);
    await page.goto("/dashboard/utlegg");
    await expect(page.getByRole("heading", { name: "Utlegg", exact: true })).toBeVisible();
    await expect(page.getByTestId("receipt-approval-list")).toBeVisible();
    const noneScopeAlert = page.getByRole("alert").first();
    await expect(noneScopeAlert).toHaveAttribute("data-error-tag", "ReceiptScopeDenied");
    await expect(page).toHaveURL(/\/dashboard\/utlegg$/);
    expect(
      (await page.context().cookies(DASHBOARD_ORIGIN))
        .filter(({ name }) => name.endsWith("better-auth.session_token"))
        .map(({ name }) => name),
    ).toEqual(sessions.noneScope.sessionCookieNames);

    const refundReceipt = await submitReceipt(
      request,
      sessions.ownerA.cookie,
      "Department A receipt to refund",
      12_550,
    );
    const rejectReceipt = await submitReceipt(
      request,
      sessions.ownerB.cookie,
      "Department B receipt to reject",
      2_075,
    );
    const staleReceipt = await submitReceipt(
      request,
      sessions.ownerA.cookie,
      "Department A stale browser receipt",
      3_300,
    );
    const concurrentReceipt = await submitReceipt(
      request,
      sessions.ownerA.cookie,
      "Department A concurrent receipt",
      4_400,
    );

    const fileIdentitiesBefore = await readFileIdentities();

    const inactiveCommandResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(refundReceipt.projection.receiptId)}/refund`,
      {
        headers: sessionHeaders(sessions.inactive.cookie),
        data: {
          commandId: randomUUID(),
          expectedRevision: 0,
        },
      },
    );
    expect(inactiveCommandResponse.status()).toBe(403);
    const inactiveCommandTag = await responseErrorTag(inactiveCommandResponse);
    expect(inactiveCommandTag).toBe("InactiveActor");

    const malformedJsonResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(refundReceipt.projection.receiptId)}/refund`,
      {
        headers: {
          ...sessionHeaders(sessions.departmentA.cookie),
          "content-type": "application/json",
        },
        data: '{"commandId":',
      },
    );
    expect(malformedJsonResponse.status()).toBe(422);
    const malformedJsonTag = await responseErrorTag(malformedJsonResponse);
    expect(malformedJsonTag).toBe("ReceiptDecodeError");

    const excessJsonResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(refundReceipt.projection.receiptId)}/refund`,
      {
        headers: sessionHeaders(sessions.departmentA.cookie),
        data: {
          commandId: randomUUID(),
          expectedRevision: 0,
          unexpected: true,
        },
      },
    );
    expect(excessJsonResponse.status()).toBe(422);
    const excessJsonTag = await responseErrorTag(excessJsonResponse);
    expect(excessJsonTag).toBe("ReceiptDecodeError");

    const queryRejectedResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(refundReceipt.projection.receiptId)}/refund?unexpected=1`,
      {
        headers: sessionHeaders(sessions.departmentA.cookie),
        data: {
          commandId: randomUUID(),
          expectedRevision: 0,
        },
      },
    );
    expect(queryRejectedResponse.status()).toBe(422);
    const queryRejectedTag = await responseErrorTag(queryRejectedResponse);
    expect(queryRejectedTag).toBe("ReceiptDecodeError");

    const invalidFilterResponse = await request.get(
      `${BACKEND_ORIGIN}/api/admin/receipts?status=Pending&unexpected=1`,
      {
        headers: sessionHeaders(sessions.departmentA.cookie),
      },
    );
    expect(invalidFilterResponse.status()).toBe(422);
    const invalidFilterTag = await responseErrorTag(invalidFilterResponse);
    expect(invalidFilterTag).toBe("ReceiptDecodeError");

    const departmentAId = refundReceipt.projection.departmentId;
    const departmentBId = rejectReceipt.projection.departmentId;
    expect(departmentAId).not.toBe(departmentBId);
    expect(staleReceipt.projection.departmentId).toBe(departmentAId);
    expect(concurrentReceipt.projection.departmentId).toBe(departmentAId);

    const departmentAProjection = await listForApproval(request, sessions.departmentA.cookie);
    const departmentAReceiptIds = departmentAProjection.items.map((item) => item.receiptId);
    expect(departmentAReceiptIds).toEqual(
      expect.arrayContaining([
        refundReceipt.projection.receiptId,
        staleReceipt.projection.receiptId,
        concurrentReceipt.projection.receiptId,
      ]),
    );
    expect(departmentAReceiptIds).not.toContain(rejectReceipt.projection.receiptId);
    expect(departmentAProjection.items.every((item) => item.departmentId === departmentAId)).toBe(
      true,
    );

    const departmentBProjection = await listForApproval(request, sessions.departmentB.cookie);
    const departmentBReceiptIds = departmentBProjection.items.map((item) => item.receiptId);
    expect(departmentBReceiptIds).toContain(rejectReceipt.projection.receiptId);
    expect(departmentBReceiptIds).not.toContain(refundReceipt.projection.receiptId);
    expect(departmentBProjection.items.every((item) => item.departmentId === departmentBId)).toBe(
      true,
    );

    const globalProjection = await listForApproval(request, sessions.global.cookie);
    const globalReceiptIds = globalProjection.items.map((item) => item.receiptId);
    expect(globalReceiptIds).toEqual(
      expect.arrayContaining([
        refundReceipt.projection.receiptId,
        rejectReceipt.projection.receiptId,
        staleReceipt.projection.receiptId,
        concurrentReceipt.projection.receiptId,
      ]),
    );

    await usePersona(page, sessions.departmentA);
    await page.goto("/dashboard/utlegg");
    await expect(page.getByRole("heading", { name: "Utlegg", exact: true })).toBeVisible();
    await expect(page.getByTestId("receipt-approval-list")).toBeVisible();

    let refundRow = receiptRowFor(page, refundReceipt.projection.receiptId);
    await expect(refundRow).toHaveCount(1);
    await expect(refundRow.getByTestId("approval-receipt-id")).toHaveText(
      refundReceipt.projection.receiptId,
    );
    await expect(refundRow.getByTestId("approval-visual-id")).toHaveText(
      refundReceipt.projection.visualId,
    );
    await expect(refundRow.getByTestId("approval-owner-id")).toHaveText(
      refundReceipt.projection.ownerPersonId,
    );
    await expect(refundRow.getByTestId("approval-department-id")).toHaveText(departmentAId);
    await expect(
      refundRow.locator(`[data-amount-ore="${refundReceipt.projection.amountOre}"]`),
    ).toHaveText("125,50 NOK");
    await expect(refundRow.locator('[data-status="Pending"]')).toHaveText("Venter");
    await expect(refundRow.locator('[data-revision="0"]')).toHaveText("Versjon 0");
    await expect(receiptRowFor(page, rejectReceipt.projection.receiptId)).toHaveCount(0);

    await usePersona(page, sessions.global);
    await page.goto("/dashboard/utlegg");
    await expect(receiptRowFor(page, refundReceipt.projection.receiptId)).toHaveCount(1);
    await expect(receiptRowFor(page, rejectReceipt.projection.receiptId)).toHaveCount(1);

    const foreignScopeResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(rejectReceipt.projection.receiptId)}/refund`,
      {
        headers: sessionHeaders(sessions.departmentA.cookie),
        data: {
          commandId: randomUUID(),
          expectedRevision: 0,
        },
      },
    );
    expect(foreignScopeResponse.status()).toBe(403);
    const foreignScopeTag = await responseErrorTag(foreignScopeResponse);
    expect(foreignScopeTag).toBe("ReceiptScopeDenied");

    const absentReceiptId = `receipt-absent-${randomUUID()}`;
    const absentScopeResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(absentReceiptId)}/refund`,
      {
        headers: sessionHeaders(sessions.departmentA.cookie),
        data: {
          commandId: randomUUID(),
          expectedRevision: 0,
        },
      },
    );
    expect(absentScopeResponse.status()).toBe(403);
    const absentScopeTag = await responseErrorTag(absentScopeResponse);
    expect(absentScopeTag).toBe(foreignScopeTag);

    const globalAbsentResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(absentReceiptId)}/refund`,
      {
        headers: sessionHeaders(sessions.global.cookie),
        data: {
          commandId: randomUUID(),
          expectedRevision: 0,
        },
      },
    );
    expect(globalAbsentResponse.status()).toBe(404);
    const globalAbsentTag = await responseErrorTag(globalAbsentResponse);
    expect(globalAbsentTag).toBe("ReceiptNotFound");

    const browserForeignRow = receiptRowFor(page, rejectReceipt.projection.receiptId);
    await usePersona(page, sessions.departmentA);
    await browserForeignRow.getByRole("button", { name: "Refunder", exact: true }).click();
    const browserScopeForm = page.locator('form[data-receipt-resolution="refund"]');
    await expect(browserScopeForm).toBeVisible();
    await expect(browserScopeForm.locator('input[name="receiptId"]')).toHaveValue(
      rejectReceipt.projection.receiptId,
    );
    const browserScopeCommandId = await browserScopeForm
      .locator('input[name="commandId"]')
      .inputValue();
    expect(browserScopeCommandId).not.toBe("");
    await browserScopeForm.getByRole("button", { name: "Bekreft refusjon", exact: true }).click();
    const browserScopeAlert = page.locator(
      `[role="alert"][data-receipt-id=${JSON.stringify(rejectReceipt.projection.receiptId)}]`,
    );
    await expect(browserScopeAlert).toHaveAttribute("data-error-tag", "ReceiptScopeDenied");
    await expect(browserScopeAlert).toHaveAttribute("data-command-id", browserScopeCommandId);
    await expect(page).toHaveURL(/\/dashboard\/utlegg(?:\?index)?$/);
    expect(
      (await page.context().cookies(DASHBOARD_ORIGIN))
        .filter(({ name }) => name.endsWith("better-auth.session_token"))
        .map(({ name }) => name),
    ).toEqual(sessions.departmentA.sessionCookieNames);

    await usePersona(page, sessions.global);
    await page.goto("/dashboard/utlegg");
    await expect(receiptRowFor(page, refundReceipt.projection.receiptId)).toHaveCount(1);
    await expect(receiptRowFor(page, rejectReceipt.projection.receiptId)).toHaveCount(1);
    const rejectReceiptAfterDenied = (
      await listForApproval(request, sessions.global.cookie)
    ).items.find((item) => item.receiptId === rejectReceipt.projection.receiptId);
    expect(rejectReceiptAfterDenied).toMatchObject({ status: "Pending", revision: 0 });

    const refundCommandId = await resolveThroughUi(
      page,
      refundReceipt.projection.receiptId,
      "refund",
    );
    refundRow = receiptRowFor(page, refundReceipt.projection.receiptId);
    await expect(refundRow.locator('[data-status="Refunded"]')).toHaveText("Refundert");
    await expect(refundRow.locator('[data-revision="1"]')).toHaveText("Versjon 1");
    await expectNoResolutionControls(refundRow);

    await page.reload();
    refundRow = receiptRowFor(page, refundReceipt.projection.receiptId);
    await expect(refundRow.locator('[data-status="Refunded"]')).toBeVisible();
    await expect(refundRow.locator('[data-revision="1"]')).toBeVisible();
    await expectNoResolutionControls(refundRow);

    const refundReplayResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(refundReceipt.projection.receiptId)}/refund`,
      {
        headers: sessionHeaders(sessions.global.cookie),
        data: {
          commandId: refundCommandId,
          expectedRevision: 0,
        },
      },
    );
    expect(refundReplayResponse.status()).toBe(200);
    const refundReplay = receiptObservationSchema.parse(await refundReplayResponse.json());
    expect(refundReplay).toMatchObject({
      commandId: refundCommandId,
      receiptId: refundReceipt.projection.receiptId,
      status: "Refunded",
      revision: 1,
      replayed: true,
    });
    await listForApproval(request, sessions.global.cookie);

    const conflictingReplayResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(refundReceipt.projection.receiptId)}/refund`,
      {
        headers: sessionHeaders(sessions.global.cookie),
        data: {
          commandId: refundCommandId,
          expectedRevision: 1,
        },
      },
    );
    expect(conflictingReplayResponse.status()).toBe(409);
    const conflictingReplayTag = await responseErrorTag(conflictingReplayResponse);
    expect(conflictingReplayTag).toBe("DuplicateReceiptCommandConflict");

    const staleTerminalResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(refundReceipt.projection.receiptId)}/reject`,
      {
        headers: sessionHeaders(sessions.global.cookie),
        data: {
          commandId: randomUUID(),
          expectedRevision: 0,
        },
      },
    );
    expect(staleTerminalResponse.status()).toBe(409);
    const staleTerminalTag = await responseErrorTag(staleTerminalResponse);
    expect(staleTerminalTag).toBe("StaleReceiptRevision");

    const terminalRefundResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(refundReceipt.projection.receiptId)}/reject`,
      {
        headers: sessionHeaders(sessions.global.cookie),
        data: {
          commandId: randomUUID(),
          expectedRevision: 1,
        },
      },
    );
    expect(terminalRefundResponse.status()).toBe(409);
    const terminalRefundTag = await responseErrorTag(terminalRefundResponse);
    expect(terminalRefundTag).toBe("InvalidReceiptTransition");

    const rejectCommandId = await resolveThroughUi(
      page,
      rejectReceipt.projection.receiptId,
      "reject",
    );
    let rejectRow = receiptRowFor(page, rejectReceipt.projection.receiptId);
    await expect(rejectRow.locator('[data-status="Rejected"]')).toHaveText("Avvist");
    await expect(rejectRow.locator('[data-revision="1"]')).toHaveText("Versjon 1");
    await expectNoResolutionControls(rejectRow);

    const rejectReplayResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(rejectReceipt.projection.receiptId)}/reject`,
      {
        headers: sessionHeaders(sessions.global.cookie),
        data: {
          commandId: rejectCommandId,
          expectedRevision: 0,
        },
      },
    );
    expect(rejectReplayResponse.status()).toBe(200);
    const rejectReplay = receiptObservationSchema.parse(await rejectReplayResponse.json());
    expect(rejectReplay).toMatchObject({
      commandId: rejectCommandId,
      receiptId: rejectReceipt.projection.receiptId,
      status: "Rejected",
      revision: 1,
      replayed: true,
    });
    await listForApproval(request, sessions.global.cookie);

    const terminalRejectResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(rejectReceipt.projection.receiptId)}/refund`,
      {
        headers: sessionHeaders(sessions.global.cookie),
        data: {
          commandId: randomUUID(),
          expectedRevision: 1,
        },
      },
    );
    expect(terminalRejectResponse.status()).toBe(409);
    const terminalRejectTag = await responseErrorTag(terminalRejectResponse);
    expect(terminalRejectTag).toBe("InvalidReceiptTransition");

    let staleRow = receiptRowFor(page, staleReceipt.projection.receiptId);
    await staleRow.getByRole("button", { name: "Refunder", exact: true }).click();
    const staleForm = page.locator('form[data-receipt-resolution="refund"]');
    await expect(staleForm.locator('input[name="expectedRevision"]')).toHaveValue("0");
    const staleBrowserCommandId = await staleForm.locator('input[name="commandId"]').inputValue();
    expect(staleBrowserCommandId).not.toBe("");

    const externalResolutionCommandId = randomUUID();
    const externalResolutionResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(staleReceipt.projection.receiptId)}/reject`,
      {
        headers: sessionHeaders(sessions.global.cookie),
        data: {
          commandId: externalResolutionCommandId,
          expectedRevision: 0,
        },
      },
    );
    expect(externalResolutionResponse.status()).toBe(200);
    expect(receiptObservationSchema.parse(await externalResolutionResponse.json())).toMatchObject({
      commandId: externalResolutionCommandId,
      status: "Rejected",
      revision: 1,
      replayed: false,
    });
    await listForApproval(request, sessions.global.cookie);

    await staleForm.getByRole("button", { name: "Bekreft refusjon", exact: true }).click();
    const staleAlert = page.locator(
      `[role="alert"][data-receipt-id=${JSON.stringify(staleReceipt.projection.receiptId)}]`,
    );
    await expect(staleAlert).toHaveAttribute("data-error-tag", "StaleReceiptRevision");
    await expect(staleAlert).toHaveAttribute("data-action-intent", "refund");
    await expect(staleAlert).toHaveAttribute("data-expected-revision", "0");
    await expect(staleAlert).toHaveAttribute("data-command-id", staleBrowserCommandId);
    staleRow = receiptRowFor(page, staleReceipt.projection.receiptId);
    await expect(staleRow.locator('[data-status="Rejected"]')).toHaveText("Avvist");
    await expect(staleRow.locator('[data-revision="1"]')).toHaveText("Versjon 1");
    await expectNoResolutionControls(staleRow);

    const concurrentRefundCommandId = randomUUID();
    const concurrentRejectCommandId = randomUUID();
    const [concurrentRefundResponse, concurrentRejectResponse] = await Promise.all([
      request.post(
        `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(concurrentReceipt.projection.receiptId)}/refund`,
        {
          headers: sessionHeaders(sessions.global.cookie),
          data: {
            commandId: concurrentRefundCommandId,
            expectedRevision: 0,
          },
        },
      ),
      request.post(
        `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(concurrentReceipt.projection.receiptId)}/reject`,
        {
          headers: sessionHeaders(sessions.global.cookie),
          data: {
            commandId: concurrentRejectCommandId,
            expectedRevision: 0,
          },
        },
      ),
    ]);
    const concurrentAttempts = [
      {
        intent: "refund" as const,
        commandId: concurrentRefundCommandId,
        response: concurrentRefundResponse,
      },
      {
        intent: "reject" as const,
        commandId: concurrentRejectCommandId,
        response: concurrentRejectResponse,
      },
    ];
    expect(concurrentAttempts.filter((attempt) => attempt.response.status() === 200)).toHaveLength(
      1,
    );
    expect(concurrentAttempts.filter((attempt) => attempt.response.status() === 409)).toHaveLength(
      1,
    );
    const concurrentWinner = concurrentAttempts.find(
      (attempt) => attempt.response.status() === 200,
    );
    const concurrentLoser = concurrentAttempts.find((attempt) => attempt.response.status() === 409);
    if (concurrentWinner === undefined || concurrentLoser === undefined) {
      throw new Error("Concurrent Receipt resolution did not produce exactly one winner and loser");
    }
    const concurrentObservation = receiptObservationSchema.parse(
      await concurrentWinner.response.json(),
    );
    expect(concurrentObservation).toMatchObject({
      commandId: concurrentWinner.commandId,
      receiptId: concurrentReceipt.projection.receiptId,
      status: concurrentWinner.intent === "refund" ? "Refunded" : "Rejected",
      revision: 1,
      replayed: false,
    });
    const concurrentLoserTag = await responseErrorTag(concurrentLoser.response);
    expect(["StaleReceiptRevision", "InvalidReceiptTransition"]).toContain(concurrentLoserTag);
    await listForApproval(request, sessions.global.cookie);

    const concurrentReplayResponse = await request.post(
      `${BACKEND_ORIGIN}/api/admin/receipts/${encodeURIComponent(concurrentReceipt.projection.receiptId)}/${concurrentWinner.intent}`,
      {
        headers: sessionHeaders(sessions.global.cookie),
        data: {
          commandId: concurrentWinner.commandId,
          expectedRevision: 0,
        },
      },
    );
    expect(concurrentReplayResponse.status()).toBe(200);
    const concurrentReplay = receiptObservationSchema.parse(await concurrentReplayResponse.json());
    expect(concurrentReplay).toMatchObject({
      commandId: concurrentWinner.commandId,
      receiptId: concurrentReceipt.projection.receiptId,
      status: concurrentObservation.status,
      revision: 1,
      replayed: true,
    });
    await listForApproval(request, sessions.global.cookie);

    await page.reload();
    rejectRow = receiptRowFor(page, rejectReceipt.projection.receiptId);
    await expectNoResolutionControls(rejectRow);
    const concurrentRow = receiptRowFor(page, concurrentReceipt.projection.receiptId);
    await expect(
      concurrentRow.locator(`[data-status="${concurrentObservation.status}"]`),
    ).toBeVisible();
    await expect(concurrentRow.locator('[data-revision="1"]')).toHaveText("Versjon 1");
    await expectNoResolutionControls(concurrentRow);
    await expect(page.getByRole("button", { name: /Gjenåpne/i })).toHaveCount(0);

    const finalGlobalProjection = await listForApproval(request, sessions.global.cookie);
    const finalById = new Map(finalGlobalProjection.items.map((item) => [item.receiptId, item]));
    expect(finalById.get(refundReceipt.projection.receiptId)).toMatchObject({
      status: "Refunded",
      revision: 1,
    });
    expect(finalById.get(rejectReceipt.projection.receiptId)).toMatchObject({
      status: "Rejected",
      revision: 1,
    });
    expect(finalById.get(staleReceipt.projection.receiptId)).toMatchObject({
      status: "Rejected",
      revision: 1,
    });
    expect(finalById.get(concurrentReceipt.projection.receiptId)).toMatchObject({
      status: concurrentObservation.status,
      revision: 1,
    });

    const durablePostgresFailure = await observeDurablePostgresFailure(
      request,
      sessions.global.cookie,
    );
    const recoveredGlobalProjection = await listForApproval(request, sessions.global.cookie);
    expect(recoveredGlobalProjection.items).toEqual(finalGlobalProjection.items);
    const fileIdentitiesAfter = await readFileIdentities();
    expect(fileIdentitiesAfter).toEqual(fileIdentitiesBefore);

    if (RECEIPT_APPROVAL_EVIDENCE_FILE === undefined) {
      throw new Error("RECEIPT_APPROVAL_EVIDENCE_FILE is required for the real approval runner");
    }

    const allowedBrowserOrigins = new Set([DASHBOARD_ORIGIN, BACKEND_ORIGIN]);
    const forbiddenBrowserRequests = browserRequestLedger.filter(
      ({ method, origin, pathname }) =>
        !allowedBrowserOrigins.has(origin) ||
        pathname === "/api/login" ||
        pathname.startsWith("/api/fixtures") ||
        /\/api\/admin\/receipts\/[^/]+\/status$/u.test(pathname) ||
        (["PUT", "PATCH", "DELETE"].includes(method) && pathname.includes("/receipts")),
    );
    expect(forbiddenBrowserRequests).toEqual([]);

    const sessionEvidence = Object.fromEntries(
      Object.entries(sessions).map(([persona, session]) => [
        persona,
        {
          fixtureLabel: session.fixtureLabel,
          nativeLogin: true,
          sessionCookieNames: session.sessionCookieNames,
          apiSessionPath: "/api/me/session",
          personId: session.sessionPersonId,
        },
      ]),
    );
    const journeyEvidence = {
      journeyRefId: JOURNEY_REF_ID,
      acceptedStepIds: ACCEPTED_STEP_IDS,
      sessions: sessionEvidence,
      environmentTokenAuthority: false,
      fileIdentitiesBefore,
      fileIdentitiesAfter,
      durablePostgresFailure,
      receipts: {
        refund: refundReceipt.projection.receiptId,
        reject: rejectReceipt.projection.receiptId,
        stale: staleReceipt.projection.receiptId,
        concurrent: concurrentReceipt.projection.receiptId,
      },
      commands: {
        submissions: [
          refundReceipt.submissionCommandId,
          rejectReceipt.submissionCommandId,
          staleReceipt.submissionCommandId,
          concurrentReceipt.submissionCommandId,
        ],
        submissionActors: [
          {
            commandId: refundReceipt.submissionCommandId,
            personId: sessions.ownerA.sessionPersonId,
          },
          {
            commandId: rejectReceipt.submissionCommandId,
            personId: sessions.ownerB.sessionPersonId,
          },
          {
            commandId: staleReceipt.submissionCommandId,
            personId: sessions.ownerA.sessionPersonId,
          },
          {
            commandId: concurrentReceipt.submissionCommandId,
            personId: sessions.ownerA.sessionPersonId,
          },
        ],
        refund: refundCommandId,
        reject: rejectCommandId,
        stale: externalResolutionCommandId,
        concurrentWinner: concurrentWinner.commandId,
        resolutionActorPersonId: sessions.global.sessionPersonId,
      },
      statusMatrix: {
        approvalList: {
          missingSession: unauthenticatedResponse.status(),
          invalidSession: expiredApiResponse.status(),
          inactiveActor: inactiveResponse.status(),
          noScopeActor: noneScopeResponse.status(),
          departmentA: 200,
          departmentB: 200,
          global: 200,
          forcedPostgresFailure: durablePostgresFailure.status,
          recoveredAfterPostgresFailure: 200,
        },
        command: {
          inactiveActor: inactiveCommandResponse.status(),
          malformedJson: malformedJsonResponse.status(),
          excessJson: excessJsonResponse.status(),
          queryParameters: queryRejectedResponse.status(),
          foreignDepartment: foreignScopeResponse.status(),
          absentDepartmentScope: absentScopeResponse.status(),
          absentGlobalScope: globalAbsentResponse.status(),
          acceptedRefund: 200,
          acceptedReject: 200,
          identicalRefundReplay: refundReplayResponse.status(),
          identicalRejectReplay: rejectReplayResponse.status(),
          changedReplay: conflictingReplayResponse.status(),
          staleRevision: staleTerminalResponse.status(),
          terminalRefund: terminalRefundResponse.status(),
          terminalReject: terminalRejectResponse.status(),
          concurrent: [concurrentRefundResponse.status(), concurrentRejectResponse.status()].sort(),
        },
      },
      visibility: {
        departmentA: departmentAReceiptIds,
        departmentB: departmentBReceiptIds,
        global: globalReceiptIds,
      },
      accepted: {
        refund: {
          receiptId: refundReceipt.projection.receiptId,
          commandId: refundCommandId,
          status: refundReplay.status,
          revision: refundReplay.revision,
          replayed: refundReplay.replayed,
        },
        reject: {
          receiptId: rejectReceipt.projection.receiptId,
          commandId: rejectCommandId,
          status: rejectReplay.status,
          revision: rejectReplay.revision,
          replayed: rejectReplay.replayed,
        },
        concurrent: {
          receiptId: concurrentReceipt.projection.receiptId,
          winner: concurrentWinner.intent,
          commandId: concurrentWinner.commandId,
          status: concurrentObservation.status,
          revision: concurrentObservation.revision,
          replayed: concurrentReplay.replayed,
        },
      },
      rejected: {
        unauthenticated: unauthenticatedTag,
        invalidSession: expiredApiTag,
        inactive: inactiveTag,
        inactiveCommand: inactiveCommandTag,
        noneScope: noneScopeTag,
        foreignScope: foreignScopeTag,
        absentScope: absentScopeTag,
        globalAbsent: globalAbsentTag,
        browserScope: "ReceiptScopeDenied",
        malformedJson: malformedJsonTag,
        excessJson: excessJsonTag,
        queryRejected: queryRejectedTag,
        invalidFilter: invalidFilterTag,
        conflictingReplay: conflictingReplayTag,
        staleTerminal: staleTerminalTag,
        terminalRefund: terminalRefundTag,
        terminalReject: terminalRejectTag,
        browserStale: "StaleReceiptRevision",
        concurrentLoser: concurrentLoserTag,
      },
      rendered: {
        loginPersonIds: Object.values(sessions).map(({ sessionPersonId }) => sessionPersonId),
        forbiddenBrowserRequests,
        nativeReceiptRequests: browserRequestLedger.filter(
          ({ pathname }) =>
            pathname.startsWith("/api/receipts") || pathname.startsWith("/api/admin/receipts"),
        ),
        terminalControls: 0,
        reopenControls: 0,
        statusRevisionPairs: Array.from(finalById.values()).map((item) => ({
          receiptId: item.receiptId,
          status: item.status,
          revision: item.revision,
        })),
      },
    };
    const evidenceBytes = Buffer.from(JSON.stringify(journeyEvidence));
    await writeFile(RECEIPT_APPROVAL_EVIDENCE_FILE, evidenceBytes);
    await test.info().attach("receipt-approval-evidence.json", {
      body: evidenceBytes,
      contentType: "application/json",
    });
  });
});
