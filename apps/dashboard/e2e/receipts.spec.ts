import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Browser, type Page } from "@playwright/test";
import { z } from "zod";

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5174";
const RECEIPT_API_ORIGIN = process.env.RECEIPT_API_ORIGIN ?? "http://127.0.0.1:8790";
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
    status: z.enum(["Pending", "Refunded", "Rejected", "Withdrawn"]),
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
    status: z.enum(["Pending", "Refunded", "Rejected", "Withdrawn"]),
    revision: z.number().int().nonnegative(),
  })
  .strict();

const receiptPageSchema = z
  .object({
    items: z.array(receiptProjectionSchema),
    totalItems: z.number().int().nonnegative(),
  })
  .strict();

function activeToken(): string {
  const token = process.env.RECEIPT_E2E_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("RECEIPT_E2E_TOKEN is required for the real Receipt journey");
  }
  return token;
}

function foreignOwnerToken(): string {
  const token = process.env.RECEIPT_E2E_FOREIGN_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error("RECEIPT_E2E_FOREIGN_TOKEN is required for the real Receipt journey");
  }
  return token;
}

async function authenticate(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: "jwt_token",
      value: activeToken(),
      url: DASHBOARD_ORIGIN,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function expectUnauthenticatedBrowser(browser: Browser): Promise<void> {
  const context = await browser.newContext({ baseURL: DASHBOARD_ORIGIN });
  try {
    await context.addCookies([
      {
        name: "jwt_token",
        value: "invalid-local-receipt-token",
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

async function responseErrorTag(response: APIResponse): Promise<string> {
  return receiptErrorSchema.parse(await response.json()).error.tag;
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
    const authorization = {
      Authorization: `Bearer ${activeToken()}`,
    };
    const unauthenticatedResponse = await request.get(`${RECEIPT_API_ORIGIN}/api/receipts`);
    expect(unauthenticatedResponse.status()).toBe(401);
    const unauthenticatedTag = await responseErrorTag(unauthenticatedResponse);
    expect(unauthenticatedTag).toBe("UnauthenticatedActor");
    await expectUnauthenticatedBrowser(browser);

    await authenticate(page);
    await page.goto("/dashboard/mine-utlegg");
    await expect(page.getByRole("heading", { name: "Mine Utlegg" })).toBeVisible();
    await expect(page.getByText("Ingen utlegg er sendt inn ennå.", { exact: true })).toBeVisible();

    const submissionForm = page.getByRole("form", { name: "Send inn utlegg" });
    await submissionForm.getByLabel(/Beskrivelse/).fill(DESCRIPTION);
    await submissionForm.getByLabel(/Beløp i NOK/).fill("125,501");
    await submissionForm.getByLabel(/Kvitteringsdato/).fill(RECEIPT_DATE);
    await submissionForm.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: RECEIPT_BYTES,
    });
    await submissionForm.getByRole("button", { name: "Send inn utlegg", exact: true }).click();

    const submissionError = submissionForm.getByRole("alert");
    await expect(submissionError).toHaveAttribute("data-error-tag", "ReceiptDecodeError");
    await expect(submissionError).toHaveAttribute("data-error-field", "amountNok");
    const submissionCommandId = await submissionForm
      .locator('input[name="commandId"]')
      .inputValue();
    expect(submissionCommandId).not.toBe("");

    await submissionForm.getByLabel(/Beløp i NOK/).fill("125,50");
    await submissionForm.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "receipt.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("unsupported"),
    });
    await submissionForm.getByRole("button", { name: "Send inn utlegg", exact: true }).click();
    await expect(submissionError).toHaveAttribute("data-error-field", "file");
    await expect(submissionForm.locator('input[name="commandId"]')).toHaveValue(
      submissionCommandId,
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
      submissionCommandId,
    );

    await submissionForm.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: RECEIPT_BYTES,
    });
    await submissionForm.getByRole("button", { name: "Send inn utlegg", exact: true }).click();

    const submissionSuccess = submissionForm.getByRole("status");
    await expect(submissionSuccess).toBeVisible();
    await expect(submissionSuccess).toHaveAttribute("data-command-id", submissionCommandId);
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

    const submitReplayResponse = await request.post(`${RECEIPT_API_ORIGIN}/api/receipts/submit`, {
      headers: authorization,
      multipart: {
        commandId: submissionCommandId,
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
    expect([200, 201]).toContain(submitReplayResponse.status());
    const submitReplay = receiptObservationSchema.parse(await submitReplayResponse.json());
    expect(submitReplay).toMatchObject({
      commandId: submissionCommandId,
      receiptId,
      status: "Pending",
      revision: 0,
      replayed: true,
    });

    const ownedAtRevisionZeroResponse = await request.get(`${RECEIPT_API_ORIGIN}/api/receipts`, {
      headers: authorization,
    });
    expect(ownedAtRevisionZeroResponse.status()).toBe(200);
    const ownedAtRevisionZero = receiptPageSchema.parse(await ownedAtRevisionZeroResponse.json());
    expect(ownedAtRevisionZero.totalItems).toBe(1);
    expect(ownedAtRevisionZero.items).toHaveLength(1);
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
    await expect(reviseForm.getByLabel(/Beløp i NOK/)).toHaveValue("125,50");
    await expect(reviseForm.getByLabel(/Kvitteringsdato/)).toHaveValue(RECEIPT_DATE);
    await expect(reviseForm.locator('input[name="expectedRevision"]')).toHaveValue("0");
    expect(
      await reviseForm.getByLabel(/Erstatt kvitteringsfil/).getAttribute("required"),
    ).toBeNull();

    await reviseForm.getByLabel(/Beskrivelse/).fill(REVISED_DESCRIPTION);
    await reviseForm.getByLabel(/Beløp i NOK/).fill("210,751");
    await reviseForm.getByLabel(/Kvitteringsdato/).fill(REVISED_RECEIPT_DATE);
    await reviseForm.getByRole("button", { name: "Lagre endringer" }).click();

    const reviseError = page.locator('[role="alert"][data-action-intent="revise"]');
    await expect(reviseError).toHaveAttribute("data-error-tag", "ReceiptDecodeError");
    await expect(reviseError).toHaveAttribute("data-error-field", "amountNok");
    await expect(reviseError).toHaveAttribute("data-expected-revision", "0");
    const stableRevisionCommandId = await reviseForm
      .locator('input[name="commandId"]')
      .inputValue();
    expect(stableRevisionCommandId).not.toBe("");

    await reviseForm.getByLabel(/Beløp i NOK/).fill("210,75");
    await reviseForm.getByRole("button", { name: "Lagre endringer" }).click();

    const revisionNotice = page.locator('[role="status"][data-action-intent="revise"]');
    await expect(revisionNotice).toBeVisible();
    await expect(revisionNotice).toHaveAttribute("data-command-id", stableRevisionCommandId);
    await expect(revisionNotice).toHaveAttribute("data-revision", "1");
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
    await expect(reviseForm.getByLabel(/Beløp i NOK/)).toHaveValue("210,75");
    await expect(reviseForm.getByLabel(/Kvitteringsdato/)).toHaveValue(REVISED_RECEIPT_DATE);
    await expect(reviseForm.locator('input[name="expectedRevision"]')).toHaveValue("1");
    await reviseForm.getByLabel(/Beskrivelse/).fill(REPLACED_DESCRIPTION);
    await reviseForm.getByLabel(/Erstatt kvitteringsfil/).setInputFiles({
      name: "replacement.png",
      mimeType: "image/png",
      buffer: RECEIPT_BYTES,
    });
    await reviseForm.getByRole("button", { name: "Lagre endringer" }).click();

    await expect(revisionNotice).toHaveAttribute("data-revision", "2");
    await expect(revisionNotice).toHaveAttribute("data-command-id", /.+/);
    const replacementCommandId = await revisionNotice.getAttribute("data-command-id");
    if (replacementCommandId === null || replacementCommandId.length === 0) {
      throw new Error("Replacement revision command ID is missing");
    }
    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow).toContainText(REPLACED_DESCRIPTION);
    await expect(receiptRow.locator('[data-revision="2"]')).toHaveText("Versjon 2");

    await page.reload();
    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow).toContainText(REPLACED_DESCRIPTION);
    await receiptRow.getByRole("button", { name: "Rediger", exact: true }).click();
    reviseForm = page.getByRole("form", { name: "Rediger utlegg" });
    await expect(reviseForm.locator('input[name="expectedRevision"]')).toHaveValue("2");
    const staleDraftCommandId = await reviseForm.locator('input[name="commandId"]').inputValue();
    expect(staleDraftCommandId).not.toBe("");
    await reviseForm.getByLabel(/Beskrivelse/).fill("This stale draft must not replace projection");

    const concurrentCommandId = randomUUID();
    const concurrentRevisionResponse = await request.post(
      `${RECEIPT_API_ORIGIN}/api/receipts/${receiptId}/revise`,
      {
        headers: authorization,
        multipart: {
          commandId: concurrentCommandId,
          expectedRevision: "2",
          description: CONCURRENT_DESCRIPTION,
          amountOre: String(REVISED_AMOUNT_ORE),
          receiptDate: REVISED_RECEIPT_DATE,
        },
      },
    );
    expect(concurrentRevisionResponse.status()).toBe(200);
    const concurrentRevision = receiptObservationSchema.parse(
      await concurrentRevisionResponse.json(),
    );
    expect(concurrentRevision).toMatchObject({
      commandId: concurrentCommandId,
      receiptId,
      status: "Pending",
      revision: 3,
      replayed: false,
    });

    await reviseForm.getByRole("button", { name: "Lagre endringer" }).click();
    await expect(reviseError).not.toHaveAttribute("data-command-id", staleDraftCommandId);
    await expect(reviseError).toHaveAttribute("data-error-tag", "StaleReceiptRevision");
    await expect(reviseError).toHaveAttribute("data-expected-revision", "2");
    reviseForm = page.getByRole("form", { name: "Rediger utlegg" });
    await expect(reviseForm).toBeVisible();
    await expect(reviseForm.getByLabel(/Beskrivelse/)).toHaveValue(CONCURRENT_DESCRIPTION);
    await expect(reviseForm.getByLabel(/Beløp i NOK/)).toHaveValue("210,75");
    await expect(reviseForm.locator('input[name="expectedRevision"]')).toHaveValue("3");
    const refreshedCommandId = await reviseForm.locator('input[name="commandId"]').inputValue();
    expect(refreshedCommandId).not.toBe("");
    expect(refreshedCommandId).not.toBe(staleDraftCommandId);
    receiptRow = receiptRowFor(page, receiptId);
    await expect(receiptRow).toContainText(CONCURRENT_DESCRIPTION);
    await expect(receiptRow.locator('[data-revision="3"]')).toHaveText("Versjon 3");

    const foreignOwnerResponse = await request.post(
      `${RECEIPT_API_ORIGIN}/api/receipts/${receiptId}/withdraw`,
      {
        headers: { Authorization: `Bearer ${foreignOwnerToken()}` },
        data: {
          commandId: randomUUID(),
          expectedRevision: 3,
        },
      },
    );
    expect(foreignOwnerResponse.status()).toBe(403);
    const foreignOwnerTag = await responseErrorTag(foreignOwnerResponse);
    expect(foreignOwnerTag).toBe("ReceiptOwnerDenied");

    await receiptRow.getByRole("button", { name: "Trekk tilbake", exact: true }).click();
    const withdrawForm = page.getByRole("form", { name: "Trekk tilbake utlegg" });
    await expect(withdrawForm).toBeVisible();
    await expect(withdrawForm.locator('input[name="expectedRevision"]')).toHaveValue("3");
    await withdrawForm.getByRole("button", { name: "Bekreft tilbaketrekking" }).click();

    const withdrawalNotice = page.locator('[role="status"][data-action-intent="withdraw"]');
    await expect(withdrawalNotice).toBeVisible();
    await expect(withdrawalNotice).toHaveAttribute("data-status", "Withdrawn");
    await expect(withdrawalNotice).toHaveAttribute("data-revision", "4");
    await expect(withdrawalNotice).toHaveAttribute("data-command-id", /.+/);
    const withdrawalCommandId = await withdrawalNotice.getAttribute("data-command-id");
    if (withdrawalCommandId === null || withdrawalCommandId.length === 0) {
      throw new Error("Withdrawal command ID is missing");
    }

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
      `${RECEIPT_API_ORIGIN}/api/receipts/${receiptId}/withdraw`,
      {
        headers: authorization,
        data: {
          commandId: withdrawalCommandId,
          expectedRevision: 3,
        },
      },
    );
    expect(withdrawalReplayResponse.status()).toBe(200);
    const withdrawalReplay = receiptObservationSchema.parse(await withdrawalReplayResponse.json());
    expect(withdrawalReplay).toMatchObject({
      commandId: withdrawalCommandId,
      receiptId,
      status: "Withdrawn",
      revision: 4,
      replayed: true,
    });

    const terminalResponse = await request.post(
      `${RECEIPT_API_ORIGIN}/api/receipts/${receiptId}/withdraw`,
      {
        headers: authorization,
        data: {
          commandId: randomUUID(),
          expectedRevision: 4,
        },
      },
    );
    expect(terminalResponse.status()).toBe(409);
    const terminalTag = await responseErrorTag(terminalResponse);
    expect(terminalTag).toBe("InvalidReceiptTransition");

    const finalOwnedResponse = await request.get(`${RECEIPT_API_ORIGIN}/api/receipts`, {
      headers: authorization,
    });
    expect(finalOwnedResponse.status()).toBe(200);
    const finalOwned = receiptPageSchema.parse(await finalOwnedResponse.json());
    expect(finalOwned.totalItems).toBe(1);
    expect(finalOwned.items).toHaveLength(1);
    expect(finalOwned.items[0]).toMatchObject({
      receiptId,
      description: CONCURRENT_DESCRIPTION,
      amountOre: REVISED_AMOUNT_ORE,
      currency: "NOK",
      receiptDate: REVISED_RECEIPT_DATE,
      status: "Withdrawn",
      revision: 4,
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
            tag: unauthenticatedTag,
          },
          rejected: [
            { tag: "ReceiptDecodeError", field: "amountNok" },
            { tag: "ReceiptDecodeError", field: "file" },
            {
              tag: "StaleReceiptRevision",
              expectedRevision: 2,
              refreshedRevision: concurrentRevision.revision,
              attemptedCommandId: staleDraftCommandId,
              retryCommandId: refreshedCommandId,
            },
            {
              tag: foreignOwnerTag,
              status: foreignOwnerResponse.status(),
              revision: 3,
            },
            {
              tag: terminalTag,
              status: terminalResponse.status(),
              revision: withdrawalReplay.revision,
            },
          ],
          accepted: {
            receiptId,
            visualId: submitReplay.visualId,
            submission: {
              commandId: submissionCommandId,
              revision: submitReplay.revision,
            },
            revisions: [
              {
                commandId: stableRevisionCommandId,
                revision: 1,
                replacement: false,
              },
              {
                commandId: replacementCommandId,
                revision: 2,
                replacement: true,
              },
              {
                commandId: concurrentCommandId,
                revision: concurrentRevision.revision,
                replacement: false,
              },
            ],
            withdrawal: {
              commandId: withdrawalCommandId,
              status: withdrawalReplay.status,
              revision: withdrawalReplay.revision,
            },
          },
          replay: {
            submission: {
              commandId: submitReplay.commandId,
              replayed: submitReplay.replayed,
            },
            withdrawal: {
              commandId: withdrawalReplay.commandId,
              replayed: withdrawalReplay.replayed,
            },
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
