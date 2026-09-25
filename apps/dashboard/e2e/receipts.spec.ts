import { Data, Predicate, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { chmod, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type Page,
} from "@playwright/test";
import {
  NativeProblem,
  ReadReceiptEvidenceEndpoint,
  ReceiptLifecycleEvidenceResponse,
  ReceiptListResponse,
  ReceiptResource,
  UserProfileResponse,
} from "@vektorprogrammet/http-api";
import { dashboardBaseUrl, dashboardMount } from "../dashboard-base";

type JourneyOutcome = Data.TaggedEnum<{
  Authenticated: {};
  Rejected: { readonly errorText: string };
  TimedOut: {};
  Observed: { readonly status: number };
  NotObserved: {};
  ExpectedError: {};
  UrlChanged: {};
  PageError: { readonly errorText: string };
}>;

const JourneyOutcome = Data.taggedEnum<JourneyOutcome>();

const DASHBOARD_MOUNT = dashboardMount(process.env);

const LOGIN_DATA_PATH = `${DASHBOARD_MOUNT}login.data`;

const OWNED_RECEIPT_DATA_PATH = `${DASHBOARD_MOUNT}mine-utlegg.data`;

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5174";

const DASHBOARD_BASE_URL = dashboardBaseUrl(DASHBOARD_ORIGIN, process.env);

const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8790";

const INTERNAL_BACKEND_ORIGIN = process.env.INTERNAL_BACKEND_ORIGIN ?? "http://127.0.0.1:8791";

const REAL_RECEIPT_OWNER_E2E = process.env.REAL_RECEIPT_OWNER_E2E === "1";

const DESCRIPTION = "Owner receipt submission";

const RECEIPT_DATE = "2026-08-21";

const AMOUNT_ORE = 12_550;

const REVISED_DESCRIPTION = "Owner receipt revised without replacement";

const REPLACED_DESCRIPTION = "Owner receipt revised with replacement";

const CONCURRENT_DESCRIPTION = "Owner receipt concurrent revision";

const REVISED_RECEIPT_DATE = "2026-08-20";

const REVISED_AMOUNT_ORE = 21_075;

const MAX_FILE_BYTES = 10_485_760;

const RECEIPT_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

// Responses decode with the API contract, so a contract change fails here instead of a copy.
const exactDecoding = { onExcessProperty: "error" } as const;

const decodeProblem = Schema.decodeUnknownSync(NativeProblem);

const decodeReceiptResource = Schema.decodeUnknownSync(ReceiptResource);

const decodeReceiptPage = Schema.decodeUnknownSync(ReceiptListResponse);

const decodeLifecycleEvidence = Schema.decodeUnknownSync(ReceiptLifecycleEvidenceResponse);

const decodeProfile = Schema.decodeUnknownSync(UserProfileResponse);

interface ReceiptPersona {
  readonly personId: string;
  readonly email: string;
  readonly password: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the real Receipt journey`);
  }

  return value;
}

/**
 * Refuses writes to the committed receipt files while `action` runs, as a read-only or
 * full volume would. A revision still commits, and its promoted file stays staged.
 */
async function withReadOnlyCommittedFiles<A>(
  committedObjectKey: string,
  action: () => Promise<A>,
): Promise<A> {
  const directory = dirname(
    join(requiredEnvironment("RECEIPT_E2E_COMMITTED_ROOT"), committedObjectKey),
  );

  const { mode } = await stat(directory);
  await chmod(directory, 0o500);

  try {
    return await action();
  } finally {
    await chmod(directory, mode & 0o7777);
  }
}

function receiptPersona(kind: "OWNER" | "FOREIGN"): ReceiptPersona {
  return {
    personId: requiredEnvironment(`RECEIPT_E2E_${kind}_PERSON_ID`),
    email: requiredEnvironment(`RECEIPT_E2E_${kind}_EMAIL`),
    password: requiredEnvironment(`RECEIPT_E2E_${kind}_PASSWORD`),
  };
}

const sessionHeaders = (cookie: string) => ({
  Cookie: cookie,
  Origin: DASHBOARD_ORIGIN,
});

async function authenticate(
  page: Page,
  request: APIRequestContext,
  persona: ReceiptPersona,
): Promise<string> {
  await page.context().clearCookies();
  await page.goto("login");
  await page.getByLabel("E-post").fill(persona.email);
  await page.getByLabel("Passord", { exact: true }).fill(persona.password);

  const loginResponsePromise = page.waitForResponse((response) => {
    const request = response.request();

    return request.method() === "POST" && new URL(response.url()).pathname === LOGIN_DATA_PATH;
  });

  await page.getByRole("button", { name: "Logg inn" }).click({ noWaitAfter: true });
  const loginResponse = await loginResponsePromise;
  const loginError = page.getByRole("alert");

  const loginOutcome = await Promise.race([
    page
      .waitForURL((url) => url.pathname === DASHBOARD_MOUNT, {
        timeout: 15_000,
        waitUntil: "commit",
      })
      .then(() => JourneyOutcome.Authenticated()),
    loginError
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(async () =>
        JourneyOutcome.Rejected({ errorText: (await loginError.innerText()).trim() }),
      ),
    page.waitForTimeout(15_000).then(() => JourneyOutcome.TimedOut()),
  ]);

  if (!Predicate.isTagged(loginOutcome, "Authenticated")) {
    const errorText =
      Predicate.isTagged(loginOutcome, "Rejected") && loginOutcome.errorText.length > 0
        ? loginOutcome.errorText
        : "<no login error rendered>";

    throw new Error(
      `Receipt owner login failed: POST ${LOGIN_DATA_PATH} status=${loginResponse.status()}; renderedError=${JSON.stringify(errorText)}`,
    );
  }

  const sessionCookies = (await page.context().cookies(DASHBOARD_ORIGIN)).filter(
    ({ name }) =>
      name === "better-auth.session_token" || name === "__Secure-better-auth.session_token",
  );

  expect(sessionCookies).toHaveLength(1);
  const sessionCookie = sessionCookies[0];

  if (sessionCookie === undefined) throw new Error("Better Auth session cookie is missing");
  const cookie = `${sessionCookie.name}=${sessionCookie.value}`;

  const profileResponse = await request.get(`${BACKEND_ORIGIN}/api/profile`, {
    headers: sessionHeaders(cookie),
  });

  expect(profileResponse.status()).toBe(200);
  expect(decodeProfile(await profileResponse.json(), exactDecoding)).toMatchObject({
    personId: persona.personId,
  });

  return cookie;
}

async function expectUnauthenticatedBrowser(browser: Browser): Promise<void> {
  const context = await browser.newContext({ baseURL: DASHBOARD_ORIGIN });

  try {
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: "invalid-local-receipt-session",
        url: DASHBOARD_ORIGIN,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    await page.goto("/dashboard/mine-utlegg");
    await expect(page).toHaveURL(/\/login\?expired=true$/);
  } finally {
    await context.close();
  }
}

async function fileNames(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names: string[] = [];

  for (const entry of entries) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      names.push(...(await fileNames(`${root}/${entry.name}`, relative)));
    } else if (entry.isFile()) {
      names.push(relative);
    }
  }

  return names.sort();
}

async function captureLifecycleEvidence(
  request: APIRequestContext,
  receiptId: string,
  sessionCookie: string,
): Promise<{
  readonly receiptId: string;
  readonly file: { readonly fileRef: string; readonly objectKey: string };
  readonly outbox: ReadonlyArray<{
    readonly effectId: string;
    readonly status: string;
    readonly attempts: number;
  }>;
  readonly audit: ReadonlyArray<{
    readonly commandId: string;
    readonly action: string;
    readonly receiptRevision: number;
  }>;
  readonly physical: {
    readonly staging: ReadonlyArray<string>;
    readonly committed: ReadonlyArray<string>;
  };
}> {
  const evidencePath = ReadReceiptEvidenceEndpoint.path.replace(
    ":receiptId",
    encodeURIComponent(receiptId),
  );

  const response = await request.get(`${INTERNAL_BACKEND_ORIGIN}${evidencePath}`, {
    headers: sessionHeaders(sessionCookie),
  });

  expect(response.status()).toBe(200);
  const stagingRoot = process.env.RECEIPT_E2E_STAGING_ROOT;
  const committedRoot = process.env.RECEIPT_E2E_COMMITTED_ROOT;

  if (stagingRoot === undefined || committedRoot === undefined) {
    throw new Error("Receipt lifecycle evidence roots are missing");
  }

  const evidence = decodeLifecycleEvidence(await response.json(), exactDecoding);

  return {
    ...evidence,
    physical: {
      staging: await fileNames(stagingRoot),
      committed: await fileNames(committedRoot),
    },
  };
}

async function expectProblemCode(
  response: APIResponse,
  expectedStatus: number,
  expectedCode: string,
): Promise<string> {
  expect(response.status()).toBe(expectedStatus);
  expect(response.headers()["content-type"]).toContain("application/problem+json");
  const problem = decodeProblem(await response.json(), exactDecoding);
  expect(problem).toMatchObject({
    status: expectedStatus,
    code: expectedCode,
    type: `urn:vektorprogrammet:problem:v0.2:${expectedCode}`,
  });

  return problem.code;
}

function receiptRowFor(page: Page, receiptId: string) {
  return page.locator(`tr[data-receipt-id=${JSON.stringify(receiptId)}]`);
}

test.describe("Native Receipt owner journey", () => {
  test.skip(!REAL_RECEIPT_OWNER_E2E, "requires the disposable native Receipt topology");

  test("revises and withdraws one durable owned Receipt through the dashboard", async ({
    browser,
    page,
    request,
  }) => {
    const unauthenticatedResponse = await request.get(`${BACKEND_ORIGIN}/api/receipts`);

    const unauthenticatedTag = await expectProblemCode(
      unauthenticatedResponse,
      401,
      "credential.missing",
    );

    await expectUnauthenticatedBrowser(browser);

    const authorization = sessionHeaders(
      await authenticate(page, request, receiptPersona("OWNER")),
    );

    await page.goto("/dashboard/mine-utlegg");
    await expect(page.getByRole("heading", { name: "Mine Utlegg" })).toBeVisible();
    await expect(page.getByText("Ingen utlegg er sendt inn ennå.", { exact: true })).toBeVisible();

    const submissionForm = page.getByRole("form", { name: "Send inn utlegg" });

    const submissionButton = submissionForm.getByRole("button", {
      name: "Send inn utlegg",
      exact: true,
    });

    await submissionForm.getByLabel(/Beskrivelse/).fill(DESCRIPTION);
    await submissionForm.locator("#amountNok").fill("125,501");
    await submissionForm.getByLabel(/Kvitteringsdato/).fill(RECEIPT_DATE);
    await submissionForm.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: RECEIPT_BYTES,
    });
    await submissionButton.click();

    const submissionError = submissionForm.getByRole("alert");
    await expect(submissionError).toHaveAttribute("data-error-tag", "ReceiptDecodeError");
    await expect(submissionError).toHaveAttribute("data-error-field", "amountNok");
    await expect(submissionForm).toHaveAttribute("aria-busy", "false");
    await expect(submissionButton).toBeEnabled();

    const submissionIdempotencyKey = await submissionForm
      .locator('input[name="commandId"]')
      .inputValue();

    expect(submissionIdempotencyKey).not.toBe("");

    await submissionForm.locator("#amountNok").fill("125,50");
    await submissionForm.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "receipt.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("unsupported"),
    });
    const unsupportedFileStartUrl = page.url();

    const unsupportedFileResponse = Promise.race([
      page
        .waitForResponse((response) => {
          const request = response.request();

          return (
            request.method() === "POST" &&
            new URL(response.url()).pathname === OWNED_RECEIPT_DATA_PATH
          );
        })
        .then((response) => JourneyOutcome.Observed({ status: response.status() })),
      page.waitForTimeout(15_000).then(() => JourneyOutcome.NotObserved()),
    ]);

    const pageLevelError = page
      .locator('[role="alert"]:not(#receipt-submit-error)')
      .or(
        page.getByText(
          /^(?:Noe gikk galt(?:\. Prøv å laste siden på nytt\.)?|Siden ble ikke funnet)$/,
        ),
      )
      .first();

    const unsupportedFileOutcome = Promise.race([
      expect(submissionError)
        .toHaveAttribute("data-error-field", "file", { timeout: 20_000 })
        .then(() => JourneyOutcome.ExpectedError()),
      page
        .waitForURL((url) => url.toString() !== unsupportedFileStartUrl, {
          timeout: 20_000,
          waitUntil: "commit",
        })
        .then(() => JourneyOutcome.UrlChanged()),
      pageLevelError
        .waitFor({ state: "visible", timeout: 20_000 })
        .then(async () =>
          JourneyOutcome.PageError({ errorText: (await pageLevelError.innerText()).trim() }),
        ),
      page.waitForTimeout(15_000).then(() => JourneyOutcome.TimedOut()),
    ]);

    await submissionButton.click();

    const [responseObservation, validationOutcome] = await Promise.all([
      unsupportedFileResponse,
      unsupportedFileOutcome,
    ]);

    if (
      !Predicate.isTagged(responseObservation, "Observed") ||
      !Predicate.isTagged(validationOutcome, "ExpectedError")
    ) {
      const formErrorText = (await submissionError.isVisible().catch(() => false))
        ? (await submissionError.innerText()).trim()
        : "";

      const pageErrorText = Predicate.isTagged(validationOutcome, "PageError")
        ? validationOutcome.errorText
        : (await pageLevelError.isVisible().catch(() => false))
          ? (await pageLevelError.innerText()).trim()
          : "";

      const renderedError = pageErrorText || formErrorText || "<no rendered error>";

      const responseStatus = Predicate.isTagged(responseObservation, "Observed")
        ? String(responseObservation.status)
        : "<not observed>";

      throw new Error(
        `Unsupported receipt file validation failed: POST ${OWNED_RECEIPT_DATA_PATH} status=${responseStatus}; outcome=${validationOutcome._tag}; currentUrl=${JSON.stringify(page.url())}; renderedError=${JSON.stringify(renderedError)}`,
      );
    }

    await expect(submissionForm.locator('input[name="commandId"]')).toHaveValue(
      submissionIdempotencyKey,
    );

    await submissionForm.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "oversized.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(MAX_FILE_BYTES + 1),
    });
    await submissionForm.getByRole("button", { name: "Send inn utlegg", exact: true }).click();
    await expect(submissionError).toContainText(
      "Kvitteringsfilen kan ikke være større enn 10 MiB.",
    );
    await expect(submissionForm.locator('input[name="commandId"]')).toHaveValue(
      submissionIdempotencyKey,
    );

    await submissionForm.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: RECEIPT_BYTES,
    });
    await submissionForm.getByRole("button", { name: "Send inn utlegg", exact: true }).click();

    const submissionSuccess = submissionForm.getByRole("status");
    await expect(submissionSuccess).toBeVisible();
    await expect(submissionSuccess).toHaveAttribute(
      "data-command-id",
      submissionIdempotencyKey,
    );
    let receiptRow = page.locator("[data-receipt-id]").filter({ hasText: DESCRIPTION });
    await expect(receiptRow).toHaveCount(1);
    const receiptId = (await receiptRow.getByTestId("receipt-id").textContent())?.trim();

    if (receiptId === undefined || receiptId.length === 0) {
      throw new Error("Rendered Receipt ID is missing");
    }

    expect(receiptId).not.toMatch(/^\d+$/);
    await expect(receiptRow).toContainText("125,50 NOK");
    await expect(receiptRow).toContainText(RECEIPT_DATE);
    await expect(receiptRow.locator('[data-status="Pending"]')).toBeVisible();
    await expect(receiptRow.locator('[data-revision="0"]')).toHaveText("Versjon 0");

    await page.reload();
    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow).toHaveCount(1);
    await expect(receiptRow).toContainText(DESCRIPTION);
    await expect(receiptRow).toContainText("125,50 NOK");
    await expect(receiptRow).toContainText(RECEIPT_DATE);
    await expect(receiptRow.locator('[data-status="Pending"]')).toBeVisible();

    const submitReplayResponse = await request.post(`${BACKEND_ORIGIN}/api/receipts`, {
      headers: {
        ...authorization,
        "Idempotency-Key": submissionIdempotencyKey,
      },
      multipart: {
        description: DESCRIPTION,
        amountOre: String(AMOUNT_ORE),
        receiptDate: RECEIPT_DATE,
        file: {
          name: "receipt.png",
          mimeType: "image/png",
          buffer: RECEIPT_BYTES,
        },
      },
    });

    expect(submitReplayResponse.status()).toBe(201);
    const submitReplay = decodeReceiptResource(await submitReplayResponse.json(), exactDecoding);
    expect(submitReplayResponse.headers()["etag"]).toBe(submitReplay.etag);
    expect(submitReplay).toMatchObject({
      receiptId,
      status: "Pending",
      revision: 0,
    });

    const ownedAtRevisionZeroResponse = await request.get(`${BACKEND_ORIGIN}/api/receipts`, {
      headers: authorization,
    });

    expect(ownedAtRevisionZeroResponse.status()).toBe(200);

    const ownedAtRevisionZero = decodeReceiptPage(
      await ownedAtRevisionZeroResponse.json(),
      exactDecoding,
    );

    expect(ownedAtRevisionZero.items).toHaveLength(1);
    const revisionZero = ownedAtRevisionZero.items[0];

    if (revisionZero === undefined) throw new Error("Owned Receipt revision zero is missing");
    expect(ownedAtRevisionZero.items[0]).toMatchObject({
      receiptId,
      description: DESCRIPTION,
      amountOre: AMOUNT_ORE,
      currency: "NOK",
      receiptDate: RECEIPT_DATE,
      status: "Pending",
      revision: 0,
    });

    await receiptRow.getByRole("button", { name: "Rediger", exact: true }).click();
    let reviseForm = page.getByRole("form", { name: "Rediger utlegg" });
    await expect(reviseForm).toBeVisible();
    await expect(reviseForm.getByLabel(/Beskrivelse/)).toHaveValue(DESCRIPTION);
    await expect(reviseForm.locator('input[name="amountNok"]')).toHaveValue("125,50");
    await expect(reviseForm.getByLabel(/Kvitteringsdato/)).toHaveValue(RECEIPT_DATE);
    await expect(reviseForm.locator('input[name="etag"]')).toHaveValue(revisionZero.etag);
    expect(
      await reviseForm.getByLabel(/Erstatt kvitteringsfil/).getAttribute("required"),
    ).toBeNull();

    await reviseForm.getByLabel(/Beskrivelse/).fill(REVISED_DESCRIPTION);
    await reviseForm.locator('input[name="amountNok"]').fill("210,751");
    await reviseForm.getByLabel(/Kvitteringsdato/).fill(REVISED_RECEIPT_DATE);
    await reviseForm.getByRole("button", { name: "Lagre endringer" }).click();

    const reviseError = page.locator('[role="alert"][data-action-intent="revise"]');
    await expect(reviseError).toHaveAttribute("data-error-tag", "ReceiptDecodeError");
    await expect(reviseError).toHaveAttribute("data-error-field", "amountNok");
    await expect(reviseError).toHaveAttribute("data-etag", revisionZero.etag);

    const stableRevisionIdempotencyKey = await reviseForm
      .locator('input[name="commandId"]')
      .inputValue();

    expect(stableRevisionIdempotencyKey).not.toBe("");

    await reviseForm.locator('input[name="amountNok"]').fill("210,75");
    await reviseForm.getByRole("button", { name: "Lagre endringer" }).click();

    const revisionNotice = page.locator('[role="status"][data-action-intent="revise"]');
    await expect(revisionNotice).toBeVisible();
    await expect(revisionNotice).toHaveAttribute(
      "data-command-id",
      stableRevisionIdempotencyKey,
    );
    await expect(revisionNotice).toHaveAttribute("data-revision", "1");
    const revisionOneEtag = await revisionNotice.getAttribute("data-etag");

    if (revisionOneEtag === null) throw new Error("Receipt revision one ETag is missing");
    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow).toContainText(REVISED_DESCRIPTION);
    await expect(receiptRow).toContainText("210,75 NOK");
    await expect(receiptRow).toContainText(REVISED_RECEIPT_DATE);
    await expect(receiptRow.locator('[data-status="Pending"]')).toBeVisible();
    await expect(receiptRow.locator('[data-revision="1"]')).toHaveText("Versjon 1");

    await page.reload();
    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow).toContainText(REVISED_DESCRIPTION);
    await expect(receiptRow.locator('[data-revision="1"]')).toBeVisible();
    await receiptRow.getByRole("button", { name: "Rediger", exact: true }).click();
    reviseForm = page.getByRole("form", { name: "Rediger utlegg" });
    await expect(reviseForm.getByLabel(/Beskrivelse/)).toHaveValue(REVISED_DESCRIPTION);
    await expect(reviseForm.locator('input[name="amountNok"]')).toHaveValue("210,75");
    await expect(reviseForm.getByLabel(/Kvitteringsdato/)).toHaveValue(REVISED_RECEIPT_DATE);
    await expect(reviseForm.locator('input[name="etag"]')).toHaveValue(revisionOneEtag);
    await reviseForm.getByLabel(/Beskrivelse/).fill(REPLACED_DESCRIPTION);
    await reviseForm.getByLabel(/Erstatt kvitteringsfil/).setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: RECEIPT_BYTES,
    });

    const replacementIdempotencyKey = requiredEnvironment(
      "RECEIPT_E2E_REPLACEMENT_IDEMPOTENCY_KEY",
    );

    await reviseForm.locator('input[name="commandId"]').evaluate((element, idempotencyKey) => {
      if (!(element instanceof HTMLInputElement)) throw new Error("Expected an idempotency input");
      const input = element;
      input.value = idempotencyKey;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, replacementIdempotencyKey);

    const beforeReplacement = await captureLifecycleEvidence(
      request,
      receiptId,
      authorization.Cookie,
    );

    // The replacement's promotion fails, so the revision commits with its new file staged.
    const beforeFailure = await withReadOnlyCommittedFiles(
      beforeReplacement.file.objectKey,
      async () => {
        await reviseForm.getByRole("button", { name: "Lagre endringer" }).click();
        await expect(revisionNotice).toHaveAttribute("data-revision", "2");
        await expect(revisionNotice).toHaveAttribute("data-command-id", replacementIdempotencyKey);

        return captureLifecycleEvidence(request, receiptId, authorization.Cookie);
      },
    );

    const revisionTwoEtag = await revisionNotice.getAttribute("data-etag");

    if (revisionTwoEtag === null) throw new Error("Receipt revision two ETag is missing");

    const replacementRetryResponse = await request.patch(
      `${BACKEND_ORIGIN}/api/receipts/${encodeURIComponent(receiptId)}`,
      {
        headers: {
          ...authorization,
          "Idempotency-Key": replacementIdempotencyKey,
          "If-Match": revisionOneEtag,
        },
        multipart: {
          description: REPLACED_DESCRIPTION,
          amountOre: String(REVISED_AMOUNT_ORE),
          receiptDate: REVISED_RECEIPT_DATE,
          file: {
            name: "replacement.png",
            mimeType: "image/png",
            buffer: RECEIPT_BYTES,
          },
        },
      },
    );

    expect(replacementRetryResponse.status()).toBe(200);

    const replacementRetry = decodeReceiptResource(
      await replacementRetryResponse.json(),
      exactDecoding,
    );

    expect(replacementRetryResponse.headers()["etag"]).toBe(replacementRetry.etag);
    expect(replacementRetry).toMatchObject({
      receiptId,
      revision: 2,
    });
    const afterRetry = await captureLifecycleEvidence(request, receiptId, authorization.Cookie);
    const lifecycleEvidencePath = process.env.RECEIPT_E2E_LIFECYCLE_EVIDENCE_PATH;

    if (lifecycleEvidencePath === undefined) {
      throw new Error("Receipt lifecycle evidence path is missing");
    }

    await writeFile(lifecycleEvidencePath, JSON.stringify({ beforeFailure, afterRetry }), "utf8");

    const stableRevisionReplayResponse = await request.patch(
      `${BACKEND_ORIGIN}/api/receipts/${encodeURIComponent(receiptId)}`,
      {
        headers: {
          ...authorization,
          "Idempotency-Key": stableRevisionIdempotencyKey,
          "If-Match": revisionZero.etag,
        },
        multipart: {
          description: REVISED_DESCRIPTION,
          amountOre: String(REVISED_AMOUNT_ORE),
          receiptDate: REVISED_RECEIPT_DATE,
        },
      },
    );

    expect(stableRevisionReplayResponse.status()).toBe(200);

    const stableRevisionReplay = decodeReceiptResource(
      await stableRevisionReplayResponse.json(),
      exactDecoding,
    );

    expect(stableRevisionReplay).toMatchObject({
      receiptId,
      revision: 1,
    });
    expect(stableRevisionReplay.etag).toBe(revisionOneEtag);

    await page.reload();
    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow).toContainText(REPLACED_DESCRIPTION);
    await receiptRow.getByRole("button", { name: "Rediger", exact: true }).click();
    reviseForm = page.getByRole("form", { name: "Rediger utlegg" });
    await expect(reviseForm.locator('input[name="etag"]')).toHaveValue(revisionTwoEtag);

    const staleDraftIdempotencyKey = await reviseForm
      .locator('input[name="commandId"]')
      .inputValue();

    expect(staleDraftIdempotencyKey).not.toBe("");
    await reviseForm.getByLabel(/Beskrivelse/).fill("This stale draft must not replace projection");

    const concurrentIdempotencyKey = randomUUID();

    const concurrentRevisionResponse = await request.patch(
      `${BACKEND_ORIGIN}/api/receipts/${encodeURIComponent(receiptId)}`,
      {
        headers: {
          ...authorization,
          "Idempotency-Key": concurrentIdempotencyKey,
          "If-Match": revisionTwoEtag,
        },
        multipart: {
          description: CONCURRENT_DESCRIPTION,
          amountOre: String(REVISED_AMOUNT_ORE),
          receiptDate: REVISED_RECEIPT_DATE,
        },
      },
    );

    expect(concurrentRevisionResponse.status()).toBe(200);

    const concurrentRevision = decodeReceiptResource(
      await concurrentRevisionResponse.json(),
      exactDecoding,
    );

    expect(concurrentRevisionResponse.headers()["etag"]).toBe(concurrentRevision.etag);
    expect(concurrentRevision).toMatchObject({
      receiptId,
      status: "Pending",
      revision: 3,
    });

    await reviseForm.getByRole("button", { name: "Lagre endringer" }).click();
    await expect(reviseError).not.toHaveAttribute("data-command-id", staleDraftIdempotencyKey);
    await expect(reviseError).toHaveAttribute("data-error-tag", "StaleReceiptRevision");
    await expect(reviseError).toHaveAttribute("data-etag", revisionTwoEtag);
    reviseForm = page.getByRole("form", { name: "Rediger utlegg" });
    await expect(reviseForm).toBeVisible();
    await expect(reviseForm.getByLabel(/Beskrivelse/)).toHaveValue(CONCURRENT_DESCRIPTION);
    await expect(reviseForm.locator('input[name="amountNok"]')).toHaveValue("210,75");
    await expect(reviseForm.locator('input[name="etag"]')).toHaveValue(concurrentRevision.etag);

    const refreshedIdempotencyKey = await reviseForm
      .locator('input[name="commandId"]')
      .inputValue();

    expect(refreshedIdempotencyKey).not.toBe("");
    expect(refreshedIdempotencyKey).not.toBe(staleDraftIdempotencyKey);
    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow).toContainText(CONCURRENT_DESCRIPTION);
    await expect(receiptRow.locator('[data-revision="3"]')).toHaveText("Versjon 3");

    const foreignContext = await browser.newContext({ baseURL: DASHBOARD_BASE_URL });
    let foreignOwnerResponse: APIResponse;

    try {
      const foreignPage = await foreignContext.newPage();
      const foreignSession = await authenticate(foreignPage, request, receiptPersona("FOREIGN"));
      foreignOwnerResponse = await request.post(
        `${BACKEND_ORIGIN}/api/receipts/${encodeURIComponent(receiptId)}:withdraw`,
        {
          headers: {
            ...sessionHeaders(foreignSession),
            "content-type": "application/json",
            "Idempotency-Key": randomUUID(),
            "If-Match": concurrentRevision.etag,
          },
          data: {},
        },
      );
    } finally {
      await foreignContext.close();
    }

    const foreignOwnerTag = await expectProblemCode(foreignOwnerResponse, 403, "authority.denied");

    await receiptRow.getByRole("button", { name: "Trekk tilbake", exact: true }).click();
    const withdrawForm = page.getByRole("form", { name: "Trekk tilbake utlegg" });
    await expect(withdrawForm).toBeVisible();
    await expect(withdrawForm.locator('input[name="etag"]')).toHaveValue(concurrentRevision.etag);

    const withdrawalIdempotencyKey = await withdrawForm
      .locator('input[name="commandId"]')
      .inputValue();

    expect(withdrawalIdempotencyKey).not.toBe("");
    await withdrawForm.getByRole("button", { name: "Bekreft tilbaketrekking" }).click();

    const withdrawalNotice = page.locator('[role="status"][data-action-intent="withdraw"]');
    await expect(withdrawalNotice).toBeVisible();
    await expect(withdrawalNotice).toHaveAttribute("data-status", "Withdrawn");
    await expect(withdrawalNotice).toHaveAttribute("data-revision", "4");
    await expect(withdrawalNotice).toHaveAttribute(
      "data-command-id",
      withdrawalIdempotencyKey,
    );
    const withdrawalEtag = await withdrawalNotice.getAttribute("data-etag");

    if (withdrawalEtag === null) throw new Error("Withdrawal ETag is missing");

    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow.locator('[data-status="Withdrawn"]')).toBeVisible();
    await expect(receiptRow.locator('[data-revision="4"]')).toHaveText("Versjon 4");
    await expect(receiptRow.getByRole("button", { name: "Rediger", exact: true })).toHaveCount(0);
    await expect(
      receiptRow.getByRole("button", { name: "Trekk tilbake", exact: true }),
    ).toHaveCount(0);
    await expect(receiptRow).toContainText("Ingen handlinger");

    await page.reload();
    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow.locator('[data-status="Withdrawn"]')).toBeVisible();
    await expect(receiptRow.locator('[data-revision="4"]')).toBeVisible();
    await expect(receiptRow.getByRole("button")).toHaveCount(0);

    const withdrawalReplayResponse = await request.post(
      `${BACKEND_ORIGIN}/api/receipts/${encodeURIComponent(receiptId)}:withdraw`,
      {
        headers: {
          ...authorization,
          "content-type": "application/json",
          "Idempotency-Key": withdrawalIdempotencyKey,
          "If-Match": concurrentRevision.etag,
        },
        data: {},
      },
    );

    expect(withdrawalReplayResponse.status()).toBe(200);

    const withdrawalReplay = decodeReceiptResource(
      await withdrawalReplayResponse.json(),
      exactDecoding,
    );

    expect(withdrawalReplayResponse.headers()["etag"]).toBe(withdrawalReplay.etag);
    expect(withdrawalReplay).toMatchObject({
      receiptId,
      status: "Withdrawn",
      revision: 4,
    });
    expect(withdrawalReplay.etag).toBe(withdrawalEtag);

    const terminalResponse = await request.post(
      `${BACKEND_ORIGIN}/api/receipts/${encodeURIComponent(receiptId)}:withdraw`,
      {
        headers: {
          ...authorization,
          "content-type": "application/json",
          "Idempotency-Key": randomUUID(),
          "If-Match": withdrawalReplay.etag,
        },
        data: {},
      },
    );

    const terminalTag = await expectProblemCode(
      terminalResponse,
      409,
      "receipt.invalid-transition",
    );

    const finalOwnedResponse = await request.get(`${BACKEND_ORIGIN}/api/receipts`, {
      headers: authorization,
    });

    expect(finalOwnedResponse.status()).toBe(200);
    const finalOwned = decodeReceiptPage(await finalOwnedResponse.json(), exactDecoding);
    expect(finalOwned.items).toHaveLength(1);
    expect(finalOwned.items[0]).toMatchObject({
      receiptId,
      description: CONCURRENT_DESCRIPTION,
      amountOre: REVISED_AMOUNT_ORE,
      currency: "NOK",
      receiptDate: REVISED_RECEIPT_DATE,
      status: "Withdrawn",
      revision: 4,
      etag: withdrawalReplay.etag,
    });

    await test.info().attach("receipt-owner-evidence.json", {
      body: Buffer.from(
        JSON.stringify({
          topology: {
            dashboard: "loopback-react-router",
            api: "native-effect-receipt",
            persistence: "postgresql",
            fileStore: "private-filesystem",
          },
          unauthenticated: {
            status: unauthenticatedResponse.status(),
            code: unauthenticatedTag,
          },
          rejected: [
            { code: "validation.failed", field: "amountNok" },
            { code: "validation.failed", field: "file" },
            {
              code: "precondition.failed",
              ifMatch: revisionTwoEtag,
              refreshedEtag: concurrentRevision.etag,
              attemptedIdempotencyKey: staleDraftIdempotencyKey,
              retryIdempotencyKey: refreshedIdempotencyKey,
            },
            {
              code: foreignOwnerTag,
              status: foreignOwnerResponse.status(),
              revision: 3,
            },
            {
              code: terminalTag,
              status: terminalResponse.status(),
              revision: withdrawalReplay.revision,
            },
          ],
          accepted: {
            receiptId,
            visualId: submitReplay.visualId,
            submission: {
              commandId: submissionIdempotencyKey,
              revision: submitReplay.revision,
            },
            revisions: [
              {
                commandId: stableRevisionIdempotencyKey,
                revision: 1,
                replacement: false,
              },
              {
                commandId: replacementIdempotencyKey,
                revision: 2,
                replacement: true,
              },
              {
                commandId: concurrentIdempotencyKey,
                revision: concurrentRevision.revision,
                replacement: false,
              },
            ],
            withdrawal: {
              commandId: withdrawalIdempotencyKey,
              status: withdrawalReplay.status,
              revision: withdrawalReplay.revision,
            },
          },
          replay: {
            submission: {
              idempotencyKey: submissionIdempotencyKey,
              identicalResource: submitReplay.receiptId === receiptId,
            },
            stableRevision: {
              idempotencyKey: stableRevisionIdempotencyKey,
              revision: stableRevisionReplay.revision,
              etag: stableRevisionReplay.etag,
            },
            replacement: {
              idempotencyKey: replacementIdempotencyKey,
              revision: replacementRetry.revision,
              etag: replacementRetry.etag,
            },
            withdrawal: {
              idempotencyKey: withdrawalIdempotencyKey,
              identicalResource: withdrawalReplay.etag === withdrawalEtag,
            },
          },
          fileLifecycle: {
            beforeFailure,
            afterRetry,
          },
          rendered: {
            receiptId,
            status: "Withdrawn",
            revision: 4,
            ownerControls: 0,
          },
        }),
      ),
      contentType: "application/json",
    });
  });
});
