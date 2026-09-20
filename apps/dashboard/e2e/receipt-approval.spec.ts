import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
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
const RECEIPT_COMMITTED_ROOT = process.env.RECEIPT_COMMITTED_ROOT;
const RECEIPT_DATE = "2026-08-22";
const PNG_RECEIPT_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const PDF_RECEIPT_BYTES = Buffer.from(
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAxIDFdID4+CmVuZG9iagp4cmVmCjAgNAowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNCAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKMTgyCiUlRU9GCg==",
  "base64",
);
const PNG_RECEIPT_FILE = {
  bytes: PNG_RECEIPT_BYTES,
  contentType: "image/png",
  extension: "png",
  name: "receipt.png",
} as const;
const PDF_RECEIPT_FILE = {
  bytes: PDF_RECEIPT_BYTES,
  contentType: "application/pdf",
  extension: "pdf",
  name: "receipt.pdf",
} as const;

const receiptStatusSchema = z.enum(["Pending", "Refunded", "Rejected", "Withdrawn"]);

const receiptProblemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    detail: z.string(),
  })
  .passthrough();

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
    etag: z.string().regex(/^"vkr2\./u),
  })
  .strict();

const receiptResourceSchema = receiptProjectionSchema.extend({
  submittedAt: z.string(),
  refundDate: z.string().nullable(),
});

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

const receiptMutationCountsSchema = z
  .object({
    auditCount: z.number().int().nonnegative(),
    commandCount: z.number().int().nonnegative(),
    outboxCount: z.number().int().nonnegative(),
    receiptCount: z.number().int().nonnegative(),
  })
  .strict();

type ReceiptProjection = z.infer<typeof receiptProjectionSchema>;
type ReceiptStatus = z.infer<typeof receiptStatusSchema>;
type ResolutionIntent = "refund" | "reject";
type FileIdentity = z.infer<typeof fileIdentitySchema>[number];
type ReceiptMutationCounts = z.infer<typeof receiptMutationCountsSchema>;
type ReceiptFileFixture = typeof PNG_RECEIPT_FILE | typeof PDF_RECEIPT_FILE;

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
  file: ReceiptFileFixture;
  projection: ReceiptProjection;
  submissionIdempotencyKey: string;
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

function sessionHeaders(cookie: string): { Cookie: string; Origin: string } {
  return { Cookie: cookie, Origin: DASHBOARD_ORIGIN };
}

const actionPath = (receiptId: string, intent: ResolutionIntent): string =>
  `${BACKEND_ORIGIN}/api/receipts/${encodeURIComponent(receiptId)}:${intent}`;

const approvalFilePath = (receiptId: string): string =>
  `${BACKEND_ORIGIN}/api/receipt-approval-queue/${encodeURIComponent(receiptId)}/file`;
const dashboardApprovalFilePath = (receiptId: string): string =>
  `${DASHBOARD_ORIGIN}/dashboard/utlegg/${encodeURIComponent(receiptId)}/file`;
const ownerFilePath = (receiptId: string): string =>
  `${BACKEND_ORIGIN}/api/receipts/${encodeURIComponent(receiptId)}/file`;

const actionHeaders = (
  cookie: string,
  idempotencyKey: string,
  ifMatch: string,
): Record<string, string> => ({
  ...sessionHeaders(cookie),
  "content-type": "application/json",
  "Idempotency-Key": idempotencyKey,
  "If-Match": ifMatch,
});

async function expectProblemCode(
  response: APIResponse,
  expectedStatus: number,
  expectedCode: string,
): Promise<string> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()["content-type"]).toContain("application/problem+json");
  const problem = receiptProblemSchema.parse(await response.json());
  expect(problem).toMatchObject({
    status: expectedStatus,
    code: expectedCode,
    type: `urn:vektorprogrammet:problem:v0.2:${expectedCode}`,
  });
  return problem.code;
}

async function expectApprovedReceiptFile(
  response: APIResponse,
  file: ReceiptFileFixture,
  fileIdentities: ReadonlyArray<FileIdentity>,
): Promise<{
  readonly byteLength: number;
  readonly contentDisposition: string;
  readonly contentType: string;
  readonly sha256: string;
}> {
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["cache-control"]).toBe("private, no-store");
  expect(headers["content-disposition"]).toBe(`inline; filename="receipt.${file.extension}"`);
  expect(headers["content-length"]).toBe(String(file.bytes.byteLength));
  expect(headers["content-type"]).toBe(file.contentType);
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers.vary).toBe("Origin");
  const exposedResponseMetadata = [response.url(), ...Object.values(headers)].join("\n");
  for (const identity of fileIdentities) {
    expect(exposedResponseMetadata).not.toContain(identity.fileRef);
    expect(exposedResponseMetadata).not.toContain(identity.objectKey);
    expect(exposedResponseMetadata).not.toContain(identity.sha256);
  }
  const bytes = await response.body();
  expect(Buffer.compare(bytes, file.bytes)).toBe(0);

  return {
    byteLength: bytes.byteLength,
    contentDisposition: headers["content-disposition"] ?? "",
    contentType: headers["content-type"] ?? "",
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function expectDashboardFileFailure(response: APIResponse, status: number): Promise<void> {
  expect(response.status()).toBe(status);
  const headers = response.headers();
  expect(headers["cache-control"]).toBe("private, no-store");
  expect(headers["content-disposition"]).toBeUndefined();
  expect(headers["content-type"]).toBeUndefined();
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect((await response.body()).byteLength).toBe(0);
}

function expectNoReceiptFileHeaders(response: APIResponse): void {
  const headers = response.headers();
  expect(headers["content-disposition"]).toBeUndefined();
  expect(headers["content-length"]).toBeUndefined();
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

const receiptMutationCountsSql = `
  SELECT json_build_object(
    'receiptCount', (SELECT count(*)::int FROM economy_receipts),
    'commandCount', (SELECT count(*)::int FROM economy_receipt_command_receipts),
    'auditCount', (SELECT count(*)::int FROM economy_receipt_audit),
    'outboxCount', (SELECT count(*)::int FROM economy_receipt_outbox)
  )::text;
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

async function readReceiptMutationCounts(): Promise<ReceiptMutationCounts> {
  return receiptMutationCountsSchema.parse(await readPostgresJson<unknown>(receiptMutationCountsSql));
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
    const response = await request.get(`${BACKEND_ORIGIN}/api/receipt-approval-queue`, {
      headers: sessionHeaders(cookie),
      timeout: 5_000,
    });
    failure = {
      status: response.status(),
      tag: await expectProblemCode(response, 503, "receipts.unavailable"),
    };
  } finally {
    await readPostgresJson<boolean>(
      "ALTER TABLE economy_receipts_failure_probe RENAME TO economy_receipts; SELECT 'true'::json::text;",
    );
  }
  if (failure === undefined) {
    throw new Error("PostgreSQL table failure did not produce a typed durable failure");
  }
  return failure;
}

async function submitReceipt(
  request: APIRequestContext,
  cookie: string,
  description: string,
  amountOre: number,
  file: ReceiptFileFixture,
): Promise<SubmittedReceipt> {
  const submissionIdempotencyKey = randomUUID();
  const response = await request.post(`${BACKEND_ORIGIN}/api/receipts`, {
    headers: {
      ...sessionHeaders(cookie),
      "Idempotency-Key": submissionIdempotencyKey,
    },
    multipart: {
      description,
      amountOre: String(amountOre),
      receiptDate: RECEIPT_DATE,
      file: {
        name: file.name,
        mimeType: file.contentType,
        buffer: file.bytes,
      },
    },
  });
  expect(response.status()).toBe(201);
  const resource = receiptResourceSchema.parse(await response.json());
  expect(resource).toMatchObject({
    status: "Pending",
    revision: 0,
  });

  const ownedResponse = await request.get(`${BACKEND_ORIGIN}/api/receipts`, {
    headers: sessionHeaders(cookie),
  });
  expect(ownedResponse.status()).toBe(200);
  const owned = receiptPageSchema.parse(await ownedResponse.json());
  const projection = owned.items.find((item) => item.receiptId === resource.receiptId);
  if (projection === undefined) {
    throw new Error(`Submitted Receipt ${resource.receiptId} is absent from its owner projection`);
  }

  return { file, projection, submissionIdempotencyKey };
}

async function listForApproval(
  request: APIRequestContext,
  cookie: string,
  status?: ReceiptStatus,
): Promise<z.infer<typeof receiptPageSchema>> {
  const query = status === undefined ? "" : `?status=${encodeURIComponent(status)}`;
  const response = await request.get(`${BACKEND_ORIGIN}/api/receipt-approval-queue${query}`, {
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
  const sessionResponse = await request.get(`${BACKEND_ORIGIN}/api/session`, {
    headers: sessionHeaders(cookie),
  });
  expect(sessionResponse.status()).toBe(200);
  expect(
    z
      .object({ sessionId: z.string(), current: z.literal(true) })
      .passthrough()
      .parse(await sessionResponse.json()),
  ).toBeDefined();
  const profileResponse = await request.get(`${BACKEND_ORIGIN}/api/profile`, {
    headers: sessionHeaders(cookie),
  });
  expect(profileResponse.status()).toBe(200);
  const profile = z
    .object({ personId: z.string() })
    .passthrough()
    .parse(await profileResponse.json());
  expect(profile.personId).toBe(persona.personId);

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
    sessionPersonId: profile.personId,
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

async function expectNoRefundOrRejectControls(row: Locator): Promise<void> {
  await expect(row.getByRole("button", { name: "Refunder", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Avvis", exact: true })).toHaveCount(0);
}

async function resolveThroughUi(
  page: Page,
  receiptId: string,
  intent: ResolutionIntent,
): Promise<{ readonly idempotencyKey: string; readonly ifMatch: string }> {
  const row = receiptRowFor(page, receiptId);
  const trigger = intent === "refund" ? "Refunder" : "Avvis";
  const confirmation = intent === "refund" ? "Bekreft refusjon" : "Bekreft avvisning";
  await row.getByRole("button", { name: trigger, exact: true }).click();

  const form = page.locator(`form[data-receipt-resolution=${JSON.stringify(intent)}]`);
  await expect(form).toBeVisible();
  await expect(form.locator('input[name="receiptId"]')).toHaveValue(receiptId);
  const ifMatch = await form.locator('input[name="etag"]').inputValue();
  expect(ifMatch).toMatch(/^"vkr2\./u);
  const idempotencyKey = await form.locator('input[name="commandId"]').inputValue();
  expect(idempotencyKey).not.toBe("");

  await form.getByRole("button", { name: confirmation, exact: true }).click();
  const notice = page.locator(`[role="status"][data-action-intent=${JSON.stringify(intent)}]`);
  await expect(notice).toHaveAttribute("data-command-id", idempotencyKey);
  await expect(notice).toHaveAttribute("data-receipt-id", receiptId);
  await expect(notice).toHaveAttribute("data-revision", "1");

  return { idempotencyKey, ifMatch };
}

test.describe("Native scoped Receipt approval journey", () => {
  test.skip(!REAL_RECEIPT_APPROVAL_E2E, "requires the disposable native Receipt approval topology");
  test.setTimeout(120_000);

  test("scopes approval file reads and enforces refund, reject, replay, concurrency, and terminal laws", async ({
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
    page.context().on("request", (browserRequest) => {
      const url = new URL(browserRequest.url());
      browserRequestLedger.push({
        method: browserRequest.method(),
        origin: url.origin,
        pathname: url.pathname,
        query: url.search,
      });
    });
    const unauthenticatedResponse = await request.get(
      `${BACKEND_ORIGIN}/api/receipt-approval-queue`,
    );
    const unauthenticatedTag = await expectProblemCode(
      unauthenticatedResponse,
      401,
      "credential.missing",
    );
    await expectUnauthenticatedBrowser(browser);

    const expiredApiResponse = await request.get(
      `${BACKEND_ORIGIN}/api/receipt-approval-queue`,
      {
        headers: sessionHeaders("better-auth.session_token=invalid-local-receipt-approval-session"),
      },
    );
    const expiredApiTag = await expectProblemCode(expiredApiResponse, 401, "credential.invalid");

    const sessions = {
      ownerA: await authenticate(page, request, environment.ownerA),
      ownerB: await authenticate(page, request, environment.ownerB),
      departmentA: await authenticate(page, request, environment.departmentA),
      departmentB: await authenticate(page, request, environment.departmentB),
      global: await authenticate(page, request, environment.global),
      inactive: await authenticate(page, request, environment.inactive),
      noneScope: await authenticate(page, request, environment.noneScope),
    };

    const inactiveResponse = await request.get(`${BACKEND_ORIGIN}/api/receipt-approval-queue`, {
      headers: sessionHeaders(sessions.inactive.cookie),
    });
    const inactiveTag = await expectProblemCode(inactiveResponse, 403, "authority.denied");

    const noneScopeResponse = await request.get(`${BACKEND_ORIGIN}/api/receipt-approval-queue`, {
      headers: sessionHeaders(sessions.noneScope.cookie),
    });
    const noneScopeTag = await expectProblemCode(noneScopeResponse, 403, "authority.denied");

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
      PNG_RECEIPT_FILE,
    );
    const rejectReceipt = await submitReceipt(
      request,
      sessions.ownerB.cookie,
      "Department B receipt to reject",
      2_075,
      PDF_RECEIPT_FILE,
    );
    const staleReceipt = await submitReceipt(
      request,
      sessions.ownerA.cookie,
      "Department A stale browser receipt",
      3_300,
      PNG_RECEIPT_FILE,
    );
    const concurrentReceipt = await submitReceipt(
      request,
      sessions.ownerA.cookie,
      "Department A concurrent receipt",
      4_400,
      PNG_RECEIPT_FILE,
    );

    const fileIdentitiesBefore = await readFileIdentities();

    const fileReadMutationCountsBefore = await readReceiptMutationCounts();
    const unauthenticatedApprovalFileResponse = await request.get(
      approvalFilePath(refundReceipt.projection.receiptId),
    );
    const unauthenticatedApprovalFileTag = await expectProblemCode(
      unauthenticatedApprovalFileResponse,
      401,
      "credential.missing",
    );
    expectNoReceiptFileHeaders(unauthenticatedApprovalFileResponse);

    const invalidApprovalFileResponse = await request.get(
      approvalFilePath(refundReceipt.projection.receiptId),
      {
        headers: sessionHeaders("better-auth.session_token=invalid-local-receipt-approval-session"),
      },
    );
    const invalidApprovalFileTag = await expectProblemCode(
      invalidApprovalFileResponse,
      401,
      "credential.invalid",
    );
    expectNoReceiptFileHeaders(invalidApprovalFileResponse);

    const activePngApprovalFileResponse = await request.get(
      approvalFilePath(refundReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.departmentA.cookie) },
    );
    const activePngApprovalFile = await expectApprovedReceiptFile(
      activePngApprovalFileResponse,
      refundReceipt.file,
      fileIdentitiesBefore,
    );
    expect(activePngApprovalFileResponse.url()).toBe(
      approvalFilePath(refundReceipt.projection.receiptId),
    );

    const activePdfApprovalFileResponse = await request.get(
      approvalFilePath(rejectReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.departmentB.cookie) },
    );
    const activePdfApprovalFile = await expectApprovedReceiptFile(
      activePdfApprovalFileResponse,
      rejectReceipt.file,
      fileIdentitiesBefore,
    );
    expect(activePdfApprovalFileResponse.url()).toBe(
      approvalFilePath(rejectReceipt.projection.receiptId),
    );

    const ownerFileResponse = await request.get(ownerFilePath(refundReceipt.projection.receiptId), {
      headers: sessionHeaders(sessions.ownerA.cookie),
    });
    expect(ownerFileResponse.status()).toBe(200);
    const ownerFileMetadata = [ownerFileResponse.url(), ...Object.values(ownerFileResponse.headers())].join(
      "\n",
    );
    for (const identity of fileIdentitiesBefore) {
      expect(ownerFileMetadata).not.toContain(identity.fileRef);
      expect(ownerFileMetadata).not.toContain(identity.objectKey);
      expect(ownerFileMetadata).not.toContain(identity.sha256);
    }
    expect(Buffer.compare(await ownerFileResponse.body(), refundReceipt.file.bytes)).toBe(0);

    const ownerApprovalFileResponse = await request.get(
      approvalFilePath(refundReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.ownerA.cookie) },
    );
    const ownerApprovalFileTag = await expectProblemCode(
      ownerApprovalFileResponse,
      403,
      "authority.denied",
    );
    expectNoReceiptFileHeaders(ownerApprovalFileResponse);

    const foreignOwnerFileResponse = await request.get(ownerFilePath(refundReceipt.projection.receiptId), {
      headers: sessionHeaders(sessions.ownerB.cookie),
    });
    const foreignOwnerFileTag = await expectProblemCode(
      foreignOwnerFileResponse,
      404,
      "resource.not-found",
    );
    expectNoReceiptFileHeaders(foreignOwnerFileResponse);

    const approverOwnerFileResponse = await request.get(ownerFilePath(refundReceipt.projection.receiptId), {
      headers: sessionHeaders(sessions.departmentA.cookie),
    });
    const approverOwnerFileTag = await expectProblemCode(
      approverOwnerFileResponse,
      404,
      "resource.not-found",
    );
    expectNoReceiptFileHeaders(approverOwnerFileResponse);

    const foreignApprovalFileResponse = await request.get(
      approvalFilePath(rejectReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.departmentA.cookie) },
    );
    const foreignApprovalFileTag = await expectProblemCode(
      foreignApprovalFileResponse,
      403,
      "authority.denied",
    );
    expectNoReceiptFileHeaders(foreignApprovalFileResponse);

    const inactiveApprovalFileResponse = await request.get(
      approvalFilePath(refundReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.inactive.cookie) },
    );
    const inactiveApprovalFileTag = await expectProblemCode(
      inactiveApprovalFileResponse,
      403,
      "authority.denied",
    );
    expectNoReceiptFileHeaders(inactiveApprovalFileResponse);

    const noScopeApprovalFileResponse = await request.get(
      approvalFilePath(refundReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.noneScope.cookie) },
    );
    const noScopeApprovalFileTag = await expectProblemCode(
      noScopeApprovalFileResponse,
      403,
      "authority.denied",
    );
    expectNoReceiptFileHeaders(noScopeApprovalFileResponse);

    const absentApprovalFileResponse = await request.get(
      approvalFilePath(`receipt-absent-file-${randomUUID()}`),
      { headers: sessionHeaders(sessions.global.cookie) },
    );
    const absentApprovalFileTag = await expectProblemCode(
      absentApprovalFileResponse,
      404,
      "resource.not-found",
    );
    expectNoReceiptFileHeaders(absentApprovalFileResponse);

    const dashboardPngFileResponse = await request.get(
      dashboardApprovalFilePath(refundReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.departmentA.cookie) },
    );
    const dashboardPngFile = await expectApprovedReceiptFile(
      dashboardPngFileResponse,
      refundReceipt.file,
      fileIdentitiesBefore,
    );
    expect(dashboardPngFileResponse.url()).toBe(
      dashboardApprovalFilePath(refundReceipt.projection.receiptId),
    );

    const dashboardPdfFileResponse = await request.get(
      dashboardApprovalFilePath(rejectReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.departmentB.cookie) },
    );
    const dashboardPdfFile = await expectApprovedReceiptFile(
      dashboardPdfFileResponse,
      rejectReceipt.file,
      fileIdentitiesBefore,
    );

    const dashboardMissingSessionFileResponse = await request.get(
      dashboardApprovalFilePath(refundReceipt.projection.receiptId),
    );
    await expectDashboardFileFailure(dashboardMissingSessionFileResponse, 401);
    const dashboardInvalidSessionFileResponse = await request.get(
      dashboardApprovalFilePath(refundReceipt.projection.receiptId),
      {
        headers: sessionHeaders("better-auth.session_token=invalid-local-receipt-approval-session"),
      },
    );
    await expectDashboardFileFailure(dashboardInvalidSessionFileResponse, 401);
    const dashboardForeignScopeFileResponse = await request.get(
      dashboardApprovalFilePath(rejectReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.departmentA.cookie) },
    );
    await expectDashboardFileFailure(dashboardForeignScopeFileResponse, 403);
    const dashboardAbsentFileResponse = await request.get(
      dashboardApprovalFilePath(`receipt-absent-dashboard-file-${randomUUID()}`),
      { headers: sessionHeaders(sessions.global.cookie) },
    );
    await expectDashboardFileFailure(dashboardAbsentFileResponse, 404);

    const refundFileIdentity = fileIdentitiesBefore.find(
      ({ receiptId }) => receiptId === refundReceipt.projection.receiptId,
    );
    if (
      RECEIPT_COMMITTED_ROOT === undefined ||
      RECEIPT_COMMITTED_ROOT.length === 0 ||
      refundFileIdentity === undefined
    ) {
      throw new Error("Committed Receipt file evidence is unavailable for the missing-object probe");
    }
    const committedFilePath = join(RECEIPT_COMMITTED_ROOT, refundFileIdentity.objectKey);
    const unavailableFilePath = `${committedFilePath}.unavailable-${randomUUID()}`;
    let missingObjectApprovalFileStatus: number | undefined;
    let missingObjectApprovalFileTag: string | undefined;
    let dashboardMissingObjectStatus: number | undefined;
    await rename(committedFilePath, unavailableFilePath);
    try {
      const missingObjectApprovalFileResponse = await request.get(
        approvalFilePath(refundReceipt.projection.receiptId),
        { headers: sessionHeaders(sessions.departmentA.cookie) },
      );
      missingObjectApprovalFileStatus = missingObjectApprovalFileResponse.status();
      missingObjectApprovalFileTag = await expectProblemCode(
        missingObjectApprovalFileResponse,
        503,
        "receipts.unavailable",
      );
      expectNoReceiptFileHeaders(missingObjectApprovalFileResponse);

      const dashboardMissingObjectFileResponse = await request.get(
        dashboardApprovalFilePath(refundReceipt.projection.receiptId),
        { headers: sessionHeaders(sessions.departmentA.cookie) },
      );
      dashboardMissingObjectStatus = dashboardMissingObjectFileResponse.status();
      await expectDashboardFileFailure(dashboardMissingObjectFileResponse, 503);
    } finally {
      await rename(unavailableFilePath, committedFilePath);
    }
    if (
      missingObjectApprovalFileStatus === undefined ||
      missingObjectApprovalFileTag === undefined ||
      dashboardMissingObjectStatus === undefined
    ) {
      throw new Error("Missing Receipt object probe did not complete");
    }

    const fileReadMutationCountsAfter = await readReceiptMutationCounts();
    expect(fileReadMutationCountsAfter).toEqual(fileReadMutationCountsBefore);

    const inactiveCommandResponse = await request.post(
      actionPath(refundReceipt.projection.receiptId, "refund"),
      {
        headers: actionHeaders(
          sessions.inactive.cookie,
          randomUUID(),
          refundReceipt.projection.etag,
        ),
        data: {},
      },
    );
    const inactiveCommandTag = await expectProblemCode(
      inactiveCommandResponse,
      403,
      "authority.denied",
    );

    const malformedJsonResponse = await request.post(
      actionPath(refundReceipt.projection.receiptId, "refund"),
      {
        headers: actionHeaders(
          sessions.departmentA.cookie,
          randomUUID(),
          refundReceipt.projection.etag,
        ),
        data: "{",
      },
    );
    const malformedJsonTag = await expectProblemCode(
      malformedJsonResponse,
      400,
      "request.malformed",
    );

    const excessJsonResponse = await request.post(
      actionPath(refundReceipt.projection.receiptId, "refund"),
      {
        headers: actionHeaders(
          sessions.departmentA.cookie,
          randomUUID(),
          refundReceipt.projection.etag,
        ),
        data: { unexpected: true },
      },
    );
    const excessJsonTag = await expectProblemCode(
      excessJsonResponse,
      422,
      "validation.failed",
    );

    const queryRejectedResponse = await request.post(
      `${actionPath(refundReceipt.projection.receiptId, "refund")}?unexpected=1`,
      {
        headers: actionHeaders(
          sessions.departmentA.cookie,
          randomUUID(),
          refundReceipt.projection.etag,
        ),
        data: {},
      },
    );
    const queryRejectedTag = await expectProblemCode(
      queryRejectedResponse,
      400,
      "request.malformed",
    );

    const invalidFilterResponse = await request.get(
      `${BACKEND_ORIGIN}/api/receipt-approval-queue?status=Pending&unexpected=1`,
      {
        headers: sessionHeaders(sessions.departmentA.cookie),
      },
    );
    const invalidFilterTag = await expectProblemCode(
      invalidFilterResponse,
      400,
      "request.malformed",
    );

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

    const browserFileReadMutationCountsBefore = await readReceiptMutationCounts();
    const approvalFileLink = refundRow.getByRole("link", { name: "Vis kvittering", exact: true });
    const dashboardRefundFilePath = `/dashboard/utlegg/${encodeURIComponent(
      refundReceipt.projection.receiptId,
    )}/file`;
    expect(page.viewportSize()).toEqual({ width: 1440, height: 900 });
    await expect(approvalFileLink).toHaveAttribute("href", dashboardRefundFilePath);
    await expect(approvalFileLink).toHaveAttribute("target", "_blank");
    await expect(approvalFileLink).toHaveAttribute("rel", "noopener noreferrer");
    await approvalFileLink.focus();
    await expect(approvalFileLink).toBeFocused();
    const [receiptFilePopup, keyboardReceiptFileResponse] = await Promise.all([
      page.context().waitForEvent("page"),
      page.context().waitForEvent(
        "response",
        (response) => response.url() === dashboardApprovalFilePath(refundReceipt.projection.receiptId),
      ),
      page.keyboard.press("Enter"),
    ]);
    try {
      await expectApprovedReceiptFile(
        keyboardReceiptFileResponse,
        refundReceipt.file,
        fileIdentitiesBefore,
      );
      expect(receiptFilePopup.url()).toBe(
        dashboardApprovalFilePath(refundReceipt.projection.receiptId),
      );
    } finally {
      await receiptFilePopup.close();
    }

    const desktopNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(desktopNoOverflow).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await usePersona(page, sessions.departmentB);
    await page.goto("/dashboard/utlegg");
    const pdfReceiptRow = receiptRowFor(page, rejectReceipt.projection.receiptId);
    const pdfApprovalFileLink = pdfReceiptRow.getByRole("link", {
      name: "Vis kvittering",
      exact: true,
    });
    await expect(pdfApprovalFileLink).toHaveAttribute(
      "href",
      `/dashboard/utlegg/${encodeURIComponent(rejectReceipt.projection.receiptId)}/file`,
    );
    await expect(pdfApprovalFileLink).toHaveAttribute("target", "_blank");
    await expect(pdfApprovalFileLink).toHaveAttribute("rel", "noopener noreferrer");
    await pdfApprovalFileLink.focus();
    await expect(pdfApprovalFileLink).toBeFocused();
    const [pdfReceiptFilePopup, keyboardPdfReceiptFileResponse] = await Promise.all([
      page.context().waitForEvent("page"),
      page.context().waitForEvent(
        "response",
        (response) => response.url() === dashboardApprovalFilePath(rejectReceipt.projection.receiptId),
      ),
      page.keyboard.press("Enter"),
    ]);
    try {
      await expectApprovedReceiptFile(
        keyboardPdfReceiptFileResponse,
        rejectReceipt.file,
        fileIdentitiesBefore,
      );
      expect(pdfReceiptFilePopup.url()).toBe(
        dashboardApprovalFilePath(rejectReceipt.projection.receiptId),
      );
    } finally {
      await pdfReceiptFilePopup.close();
    }
    const mobileNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(mobileNoOverflow).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    const browserFileReadMutationCountsAfter = await readReceiptMutationCounts();
    expect(browserFileReadMutationCountsAfter).toEqual(browserFileReadMutationCountsBefore);

    await usePersona(page, sessions.global);
    await page.goto("/dashboard/utlegg");
    await expect(receiptRowFor(page, refundReceipt.projection.receiptId)).toHaveCount(1);
    await expect(receiptRowFor(page, rejectReceipt.projection.receiptId)).toHaveCount(1);

    const foreignScopeResponse = await request.post(
      actionPath(rejectReceipt.projection.receiptId, "refund"),
      {
        headers: actionHeaders(
          sessions.departmentA.cookie,
          randomUUID(),
          rejectReceipt.projection.etag,
        ),
        data: {},
      },
    );
    const foreignScopeTag = await expectProblemCode(
      foreignScopeResponse,
      403,
      "authority.denied",
    );

    const absentReceiptId = `receipt-absent-${randomUUID()}`;
    const absentScopeResponse = await request.post(actionPath(absentReceiptId, "refund"), {
      headers: actionHeaders(
        sessions.departmentA.cookie,
        randomUUID(),
        refundReceipt.projection.etag,
      ),
      data: {},
    });
    const absentScopeTag = await expectProblemCode(
      absentScopeResponse,
      404,
      "receipt.not-found",
    );

    const globalAbsentResponse = await request.post(actionPath(absentReceiptId, "refund"), {
      headers: actionHeaders(
        sessions.global.cookie,
        randomUUID(),
        refundReceipt.projection.etag,
      ),
      data: {},
    });
    const globalAbsentTag = await expectProblemCode(
      globalAbsentResponse,
      404,
      "receipt.not-found",
    );

    const browserForeignRow = receiptRowFor(page, rejectReceipt.projection.receiptId);
    await usePersona(page, sessions.departmentA);
    await browserForeignRow.getByRole("button", { name: "Refunder", exact: true }).click();
    const browserScopeForm = page.locator('form[data-receipt-resolution="refund"]');
    await expect(browserScopeForm).toBeVisible();
    await expect(browserScopeForm.locator('input[name="receiptId"]')).toHaveValue(
      rejectReceipt.projection.receiptId,
    );
    const browserScopeIdempotencyKey = await browserScopeForm
      .locator('input[name="commandId"]')
      .inputValue();
    expect(browserScopeIdempotencyKey).not.toBe("");
    await expect(browserScopeForm.locator('input[name="etag"]')).toHaveValue(
      rejectReceipt.projection.etag,
    );
    await browserScopeForm.getByRole("button", { name: "Bekreft refusjon", exact: true }).click();
    const browserScopeAlert = page.locator(
      `[role="alert"][data-receipt-id=${JSON.stringify(rejectReceipt.projection.receiptId)}]`,
    );
    await expect(browserScopeAlert).toHaveAttribute("data-error-tag", "ReceiptScopeDenied");
    await expect(browserScopeAlert).toHaveAttribute(
      "data-command-id",
      browserScopeIdempotencyKey,
    );
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

    const refundMutation = await resolveThroughUi(
      page,
      refundReceipt.projection.receiptId,
      "refund",
    );
    refundRow = receiptRowFor(page, refundReceipt.projection.receiptId);
    await expect(refundRow.locator('[data-status="Refunded"]')).toHaveText("Refundert");
    await expect(refundRow.locator('[data-revision="1"]')).toHaveText("Versjon 1");
    await expectNoRefundOrRejectControls(refundRow);

    await page.reload();
    refundRow = receiptRowFor(page, refundReceipt.projection.receiptId);
    await expect(refundRow.locator('[data-status="Refunded"]')).toBeVisible();
    await expect(refundRow.locator('[data-revision="1"]')).toBeVisible();
    await expectNoRefundOrRejectControls(refundRow);

    const refundReplayResponse = await request.post(
      actionPath(refundReceipt.projection.receiptId, "refund"),
      {
        headers: actionHeaders(
          sessions.global.cookie,
          refundMutation.idempotencyKey,
          refundMutation.ifMatch,
        ),
        data: {},
      },
    );
    expect(refundReplayResponse.status()).toBe(200);
    const refundReplay = receiptResourceSchema.parse(await refundReplayResponse.json());
    expect(refundReplayResponse.headers()["etag"]).toBe(refundReplay.etag);
    expect(refundReplay).toMatchObject({
      receiptId: refundReceipt.projection.receiptId,
      status: "Refunded",
      revision: 1,
    });
    await listForApproval(request, sessions.global.cookie);

    const conflictingReplayResponse = await request.post(
      actionPath(refundReceipt.projection.receiptId, "refund"),
      {
        headers: actionHeaders(
          sessions.global.cookie,
          refundMutation.idempotencyKey,
          refundReplay.etag,
        ),
        data: {},
      },
    );
    const conflictingReplayTag = await expectProblemCode(
      conflictingReplayResponse,
      409,
      "idempotency.digest-conflict",
    );

    const staleTerminalResponse = await request.post(
      actionPath(refundReceipt.projection.receiptId, "reject"),
      {
        headers: actionHeaders(
          sessions.global.cookie,
          randomUUID(),
          refundMutation.ifMatch,
        ),
        data: {},
      },
    );
    const staleTerminalTag = await expectProblemCode(
      staleTerminalResponse,
      412,
      "precondition.failed",
    );

    const terminalRefundResponse = await request.post(
      actionPath(refundReceipt.projection.receiptId, "reject"),
      {
        headers: actionHeaders(sessions.global.cookie, randomUUID(), refundReplay.etag),
        data: {},
      },
    );
    const terminalRefundTag = await expectProblemCode(
      terminalRefundResponse,
      409,
      "receipt.invalid-transition",
    );

    const rejectMutation = await resolveThroughUi(
      page,
      rejectReceipt.projection.receiptId,
      "reject",
    );
    let rejectRow = receiptRowFor(page, rejectReceipt.projection.receiptId);
    await expect(rejectRow.locator('[data-status="Rejected"]')).toHaveText("Avvist");
    await expect(rejectRow.locator('[data-revision="1"]')).toHaveText("Versjon 1");
    await expectNoRefundOrRejectControls(rejectRow);

    const rejectReplayResponse = await request.post(
      actionPath(rejectReceipt.projection.receiptId, "reject"),
      {
        headers: actionHeaders(
          sessions.global.cookie,
          rejectMutation.idempotencyKey,
          rejectMutation.ifMatch,
        ),
        data: {},
      },
    );
    expect(rejectReplayResponse.status()).toBe(200);
    const rejectReplay = receiptResourceSchema.parse(await rejectReplayResponse.json());
    expect(rejectReplayResponse.headers()["etag"]).toBe(rejectReplay.etag);
    expect(rejectReplay).toMatchObject({
      receiptId: rejectReceipt.projection.receiptId,
      status: "Rejected",
      revision: 1,
    });
    await listForApproval(request, sessions.global.cookie);

    const terminalRejectResponse = await request.post(
      actionPath(rejectReceipt.projection.receiptId, "refund"),
      {
        headers: actionHeaders(sessions.global.cookie, randomUUID(), rejectReplay.etag),
        data: {},
      },
    );
    const terminalRejectTag = await expectProblemCode(
      terminalRejectResponse,
      409,
      "receipt.invalid-transition",
    );

    const terminalFileReadMutationCountsBefore = await readReceiptMutationCounts();
    const terminalRefundApprovalFileResponse = await request.get(
      approvalFilePath(refundReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.global.cookie) },
    );
    const terminalRefundApprovalFile = await expectApprovedReceiptFile(
      terminalRefundApprovalFileResponse,
      refundReceipt.file,
      fileIdentitiesBefore,
    );
    const terminalRejectApprovalFileResponse = await request.get(
      approvalFilePath(rejectReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.global.cookie) },
    );
    const terminalRejectApprovalFile = await expectApprovedReceiptFile(
      terminalRejectApprovalFileResponse,
      rejectReceipt.file,
      fileIdentitiesBefore,
    );
    const terminalRefundDashboardFileResponse = await request.get(
      dashboardApprovalFilePath(refundReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.global.cookie) },
    );
    const terminalRefundDashboardFile = await expectApprovedReceiptFile(
      terminalRefundDashboardFileResponse,
      refundReceipt.file,
      fileIdentitiesBefore,
    );
    const terminalRejectDashboardFileResponse = await request.get(
      dashboardApprovalFilePath(rejectReceipt.projection.receiptId),
      { headers: sessionHeaders(sessions.global.cookie) },
    );
    const terminalRejectDashboardFile = await expectApprovedReceiptFile(
      terminalRejectDashboardFileResponse,
      rejectReceipt.file,
      fileIdentitiesBefore,
    );
    await expect(refundRow.getByRole("link", { name: "Vis kvittering", exact: true })).toHaveAttribute(
      "href",
      `/dashboard/utlegg/${encodeURIComponent(refundReceipt.projection.receiptId)}/file`,
    );
    await expect(rejectRow.getByRole("link", { name: "Vis kvittering", exact: true })).toHaveAttribute(
      "href",
      `/dashboard/utlegg/${encodeURIComponent(rejectReceipt.projection.receiptId)}/file`,
    );
    const terminalFileReadMutationCountsAfter = await readReceiptMutationCounts();
    expect(terminalFileReadMutationCountsAfter).toEqual(terminalFileReadMutationCountsBefore);

    let staleRow = receiptRowFor(page, staleReceipt.projection.receiptId);
    await staleRow.getByRole("button", { name: "Refunder", exact: true }).click();
    const staleForm = page.locator('form[data-receipt-resolution="refund"]');
    await expect(staleForm.locator('input[name="etag"]')).toHaveValue(staleReceipt.projection.etag);
    const staleBrowserIdempotencyKey = await staleForm.locator('input[name="commandId"]').inputValue();
    expect(staleBrowserIdempotencyKey).not.toBe("");

    const externalResolutionIdempotencyKey = randomUUID();
    const externalResolutionResponse = await request.post(
      actionPath(staleReceipt.projection.receiptId, "reject"),
      {
        headers: actionHeaders(
          sessions.global.cookie,
          externalResolutionIdempotencyKey,
          staleReceipt.projection.etag,
        ),
        data: {},
      },
    );
    expect(externalResolutionResponse.status()).toBe(200);
    const externalResolution = receiptResourceSchema.parse(await externalResolutionResponse.json());
    expect(externalResolutionResponse.headers()["etag"]).toBe(externalResolution.etag);
    expect(externalResolution).toMatchObject({
      status: "Rejected",
      revision: 1,
    });
    await listForApproval(request, sessions.global.cookie);

    await staleForm.getByRole("button", { name: "Bekreft refusjon", exact: true }).click();
    const staleAlert = page.locator(
      `[role="alert"][data-receipt-id=${JSON.stringify(staleReceipt.projection.receiptId)}]`,
    );
    await expect(staleAlert).toHaveAttribute("data-error-tag", "StaleReceiptRevision");
    await expect(staleAlert).toHaveAttribute("data-action-intent", "refund");
    await expect(staleAlert).toHaveAttribute("data-etag", staleReceipt.projection.etag);
    await expect(staleAlert).toHaveAttribute("data-command-id", staleBrowserIdempotencyKey);
    staleRow = receiptRowFor(page, staleReceipt.projection.receiptId);
    await expect(staleRow.locator('[data-status="Rejected"]')).toHaveText("Avvist");
    await expect(staleRow.locator('[data-revision="1"]')).toHaveText("Versjon 1");
    await expectNoRefundOrRejectControls(staleRow);

    const concurrentReadMutationCountsBefore = await readReceiptMutationCounts();
    const concurrentRefundIdempotencyKey = randomUUID();
    const concurrentRejectIdempotencyKey = randomUUID();
    const [concurrentApprovalFileResponse, concurrentRefundResponse, concurrentRejectResponse] =
      await Promise.all([
        request.get(approvalFilePath(concurrentReceipt.projection.receiptId), {
          headers: sessionHeaders(sessions.global.cookie),
        }),
        request.post(actionPath(concurrentReceipt.projection.receiptId, "refund"), {
          headers: actionHeaders(
            sessions.global.cookie,
            concurrentRefundIdempotencyKey,
            concurrentReceipt.projection.etag,
          ),
          data: {},
        }),
        request.post(actionPath(concurrentReceipt.projection.receiptId, "reject"), {
          headers: actionHeaders(
            sessions.global.cookie,
            concurrentRejectIdempotencyKey,
            concurrentReceipt.projection.etag,
          ),
          data: {},
        }),
      ]);
    const concurrentApprovalFile = await expectApprovedReceiptFile(
      concurrentApprovalFileResponse,
      concurrentReceipt.file,
      fileIdentitiesBefore,
    );
    const concurrentReadMutationCountsAfter = await readReceiptMutationCounts();
    expect(concurrentReadMutationCountsAfter).toEqual({
      receiptCount: concurrentReadMutationCountsBefore.receiptCount,
      commandCount: concurrentReadMutationCountsBefore.commandCount + 1,
      auditCount: concurrentReadMutationCountsBefore.auditCount + 1,
      outboxCount: concurrentReadMutationCountsBefore.outboxCount + 2,
    });
    const concurrentAttempts = [
      {
        intent: "refund" as const,
        idempotencyKey: concurrentRefundIdempotencyKey,
        response: concurrentRefundResponse,
      },
      {
        intent: "reject" as const,
        idempotencyKey: concurrentRejectIdempotencyKey,
        response: concurrentRejectResponse,
      },
    ];
    expect(concurrentAttempts.filter((attempt) => attempt.response.status() === 200)).toHaveLength(
      1,
    );
    expect(concurrentAttempts.filter((attempt) => attempt.response.status() === 412)).toHaveLength(
      1,
    );
    const concurrentWinner = concurrentAttempts.find(
      (attempt) => attempt.response.status() === 200,
    );
    const concurrentLoser = concurrentAttempts.find((attempt) => attempt.response.status() === 412);
    if (concurrentWinner === undefined || concurrentLoser === undefined) {
      throw new Error("Concurrent Receipt resolution did not produce exactly one winner and loser");
    }
    const concurrentObservation = receiptResourceSchema.parse(
      await concurrentWinner.response.json(),
    );
    expect(concurrentWinner.response.headers()["etag"]).toBe(concurrentObservation.etag);
    expect(concurrentObservation).toMatchObject({
      receiptId: concurrentReceipt.projection.receiptId,
      status: concurrentWinner.intent === "refund" ? "Refunded" : "Rejected",
      revision: 1,
    });
    const concurrentLoserTag = await expectProblemCode(
      concurrentLoser.response,
      412,
      "precondition.failed",
    );
    await listForApproval(request, sessions.global.cookie);

    const concurrentReplayResponse = await request.post(
      actionPath(concurrentReceipt.projection.receiptId, concurrentWinner.intent),
      {
        headers: actionHeaders(
          sessions.global.cookie,
          concurrentWinner.idempotencyKey,
          concurrentReceipt.projection.etag,
        ),
        data: {},
      },
    );
    expect(concurrentReplayResponse.status()).toBe(200);
    const concurrentReplay = receiptResourceSchema.parse(await concurrentReplayResponse.json());
    expect(concurrentReplayResponse.headers()["etag"]).toBe(concurrentReplay.etag);
    expect(concurrentReplay).toEqual(concurrentObservation);
    await listForApproval(request, sessions.global.cookie);

    await page.reload();
    rejectRow = receiptRowFor(page, rejectReceipt.projection.receiptId);
    await expectNoRefundOrRejectControls(rejectRow);
    const concurrentRow = receiptRowFor(page, concurrentReceipt.projection.receiptId);
    await expect(
      concurrentRow.locator(`[data-status="${concurrentObservation.status}"]`),
    ).toBeVisible();
    await expect(concurrentRow.locator('[data-revision="1"]')).toHaveText("Versjon 1");
    await expectNoRefundOrRejectControls(concurrentRow);
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
    const fileIdentityChecksumBefore = `sha256:${createHash("sha256")
      .update(JSON.stringify(fileIdentitiesBefore))
      .digest("hex")}`;
    const fileIdentityChecksumAfter = `sha256:${createHash("sha256")
      .update(JSON.stringify(fileIdentitiesAfter))
      .digest("hex")}`;
    expect(fileIdentityChecksumAfter).toBe(fileIdentityChecksumBefore);

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
          apiSessionPath: "/api/session",
          personBindingPath: "/api/profile",
          personId: session.sessionPersonId,
        },
      ]),
    );
    const journeyEvidence = {
      journeyRefId: JOURNEY_REF_ID,
      acceptedStepIds: ACCEPTED_STEP_IDS,
      sessions: sessionEvidence,
      fileIdentityChecksumBefore,
      fileIdentityChecksumAfter,
      fileIdentityCount: fileIdentitiesBefore.length,
      durablePostgresFailure,
      fileReads: {
        artifacts: {
          activePng: activePngApprovalFile,
          activePdf: activePdfApprovalFile,
          dashboardPng: dashboardPngFile,
          dashboardPdf: dashboardPdfFile,
          terminalRefund: terminalRefundApprovalFile,
          terminalReject: terminalRejectApprovalFile,
          dashboardTerminalRefund: terminalRefundDashboardFile,
          dashboardTerminalReject: terminalRejectDashboardFile,
          concurrent: concurrentApprovalFile,
        },
        mutationCounts: {
          fileOnlyBefore: fileReadMutationCountsBefore,
          fileOnlyAfter: fileReadMutationCountsAfter,
          browserBefore: browserFileReadMutationCountsBefore,
          browserAfter: browserFileReadMutationCountsAfter,
          terminalBefore: terminalFileReadMutationCountsBefore,
          terminalAfter: terminalFileReadMutationCountsAfter,
          concurrentBefore: concurrentReadMutationCountsBefore,
          concurrentAfter: concurrentReadMutationCountsAfter,
        },
        rejected: {
          missingSession: unauthenticatedApprovalFileTag,
          invalidSession: invalidApprovalFileTag,
          ownerApproval: ownerApprovalFileTag,
          foreignOwner: foreignOwnerFileTag,
          approverOwner: approverOwnerFileTag,
          foreignScope: foreignApprovalFileTag,
          inactive: inactiveApprovalFileTag,
          noScope: noScopeApprovalFileTag,
          absent: absentApprovalFileTag,
          missingObject: missingObjectApprovalFileTag,
        },
      },
      receipts: {
        refund: refundReceipt.projection.receiptId,
        reject: rejectReceipt.projection.receiptId,
        stale: staleReceipt.projection.receiptId,
        concurrent: concurrentReceipt.projection.receiptId,
      },
      commands: {
        submissions: [
          refundReceipt.submissionIdempotencyKey,
          rejectReceipt.submissionIdempotencyKey,
          staleReceipt.submissionIdempotencyKey,
          concurrentReceipt.submissionIdempotencyKey,
        ],
        submissionActors: [
          {
            commandId: refundReceipt.submissionIdempotencyKey,
            personId: sessions.ownerA.sessionPersonId,
          },
          {
            commandId: rejectReceipt.submissionIdempotencyKey,
            personId: sessions.ownerB.sessionPersonId,
          },
          {
            commandId: staleReceipt.submissionIdempotencyKey,
            personId: sessions.ownerA.sessionPersonId,
          },
          {
            commandId: concurrentReceipt.submissionIdempotencyKey,
            personId: sessions.ownerA.sessionPersonId,
          },
        ],
        refund: refundMutation.idempotencyKey,
        reject: rejectMutation.idempotencyKey,
        stale: externalResolutionIdempotencyKey,
        concurrentWinner: concurrentWinner.idempotencyKey,
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
        approvalFile: {
          missingSession: unauthenticatedApprovalFileResponse.status(),
          invalidSession: invalidApprovalFileResponse.status(),
          activePng: activePngApprovalFileResponse.status(),
          activePdf: activePdfApprovalFileResponse.status(),
          ownerEndpoint: ownerFileResponse.status(),
          ownerApproval: ownerApprovalFileResponse.status(),
          foreignOwner: foreignOwnerFileResponse.status(),
          approverOwner: approverOwnerFileResponse.status(),
          foreignScope: foreignApprovalFileResponse.status(),
          inactive: inactiveApprovalFileResponse.status(),
          noScope: noScopeApprovalFileResponse.status(),
          absent: absentApprovalFileResponse.status(),
          missingObject: missingObjectApprovalFileStatus,
          terminalRefund: terminalRefundApprovalFileResponse.status(),
          terminalReject: terminalRejectApprovalFileResponse.status(),
          concurrent: concurrentApprovalFileResponse.status(),
          dashboard: {
            missingSession: dashboardMissingSessionFileResponse.status(),
            invalidSession: dashboardInvalidSessionFileResponse.status(),
            activePng: dashboardPngFileResponse.status(),
            activePdf: dashboardPdfFileResponse.status(),
            foreignScope: dashboardForeignScopeFileResponse.status(),
            absent: dashboardAbsentFileResponse.status(),
            unavailable: dashboardMissingObjectStatus,
            terminalRefund: terminalRefundDashboardFileResponse.status(),
            terminalReject: terminalRejectDashboardFileResponse.status(),
          },
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
          commandId: refundMutation.idempotencyKey,
          status: refundReplay.status,
          revision: refundReplay.revision,
          replayed: refundReplay === refundReplay,
        },
        reject: {
          receiptId: rejectReceipt.projection.receiptId,
          commandId: rejectMutation.idempotencyKey,
          status: rejectReplay.status,
          revision: rejectReplay.revision,
          replayed: rejectReplay === rejectReplay,
        },
        concurrent: {
          receiptId: concurrentReceipt.projection.receiptId,
          winner: concurrentWinner.intent,
          commandId: concurrentWinner.idempotencyKey,
          status: concurrentObservation.status,
          revision: concurrentObservation.revision,
          replayed: JSON.stringify(concurrentReplay) === JSON.stringify(concurrentObservation),
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
            pathname.startsWith("/api/receipts") ||
            pathname.startsWith("/api/receipt-approval-queue"),
        ),
        sameOriginReceiptFileRequests: browserRequestLedger.filter(
          ({ method, origin, pathname }) =>
            method === "GET" &&
            origin === DASHBOARD_ORIGIN &&
            /^\/dashboard\/utlegg\/[^/]+\/file$/u.test(pathname),
        ),
        receiptFileLink: {
          desktopNoOverflow,
          mobileNoOverflow,
          keyboardActivated: true,
          opensSeparateTab: true,
          rel: "noopener noreferrer",
        },
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
