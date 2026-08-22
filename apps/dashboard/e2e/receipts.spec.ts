import { expect, test, type APIResponse, type Browser, type Page } from "@playwright/test";
import { z } from "zod";

const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? "http://127.0.0.1:5174";
const RECEIPT_API_ORIGIN = process.env.RECEIPT_API_ORIGIN ?? "http://127.0.0.1:8790";
const REAL_RECEIPT_OWNER_E2E = process.env.REAL_RECEIPT_OWNER_E2E === "1";
const DESCRIPTION = "Owner receipt submission";
const RECEIPT_DATE = "2026-08-21";
const AMOUNT_ORE = 12_550;
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

test.describe("Native Receipt owner journey", () => {
  test.skip(!REAL_RECEIPT_OWNER_E2E, "requires the disposable native Receipt topology");

  test("persists one exact Pending receipt and preserves replay identity", async ({
    browser,
    page,
    request,
  }) => {
    const unauthenticatedResponse = await request.get(`${RECEIPT_API_ORIGIN}/api/receipts`);
    expect(unauthenticatedResponse.status()).toBe(401);
    const unauthenticatedTag = await responseErrorTag(unauthenticatedResponse);
    expect(unauthenticatedTag).toBe("UnauthenticatedActor");
    await expectUnauthenticatedBrowser(browser);

    await authenticate(page);
    await page.goto("/dashboard/mine-utlegg");
    await expect(page.getByRole("heading", { name: "Mine Utlegg" })).toBeVisible();
    await expect(page.getByText("Ingen utlegg er sendt inn ennå.", { exact: true })).toBeVisible();

    const form = page.getByRole("form", { name: "Send inn utlegg" });
    await form.getByLabel(/Beskrivelse/).fill(DESCRIPTION);
    await form.getByLabel(/Beløp i NOK/).fill("125,501");
    await form.getByLabel(/Kvitteringsdato/).fill(RECEIPT_DATE);
    await form.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: RECEIPT_BYTES,
    });
    await form.getByRole("button", { name: "Send inn utlegg", exact: true }).click();

    const formError = form.getByRole("alert");
    await expect(formError).toHaveAttribute("data-error-tag", "ReceiptDecodeError");
    await expect(formError).toHaveAttribute("data-error-field", "amountNok");
    const stableCommandId = await form.locator('input[name="commandId"]').inputValue();
    expect(stableCommandId).not.toBe("");

    await form.getByLabel(/Beløp i NOK/).fill("125,50");
    await form.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "receipt.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("unsupported"),
    });
    await form.getByRole("button", { name: "Send inn utlegg", exact: true }).click();
    await expect(formError).toHaveAttribute("data-error-field", "file");
    await expect(form.locator('input[name="commandId"]')).toHaveValue(stableCommandId);

    await form.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "oversized.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(MAX_FILE_BYTES + 1),
    });
    await form.getByRole("button", { name: "Send inn utlegg", exact: true }).click();
    await expect(formError).toContainText("Kvitteringsfilen kan ikke være større enn 10 MiB.");
    await expect(form.locator('input[name="commandId"]')).toHaveValue(stableCommandId);

    await form.getByLabel(/Kvitteringsfil/).setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: RECEIPT_BYTES,
    });
    await form.getByRole("button", { name: "Send inn utlegg", exact: true }).click();

    const success = form.getByRole("status");
    await expect(success).toBeVisible();
    await expect(success).toHaveAttribute("data-command-id", stableCommandId);
    let receiptRow = page.getByRole("row").filter({ hasText: DESCRIPTION });
    await expect(receiptRow).toHaveCount(1);
    await expect(receiptRow).toContainText("125,50 NOK");
    await expect(receiptRow).toContainText(RECEIPT_DATE);
    await expect(receiptRow).toContainText("Pending");

    await page.reload();
    receiptRow = page.getByRole("row").filter({ hasText: DESCRIPTION });
    await expect(receiptRow).toHaveCount(1);
    const renderedReceiptId = (await receiptRow.getByTestId("receipt-id").textContent())?.trim();
    if (renderedReceiptId === undefined || renderedReceiptId.length === 0) {
      throw new Error("Rendered Receipt ID is missing");
    }
    expect(renderedReceiptId).not.toMatch(/^\d+$/);
    await expect(receiptRow).toContainText("125,50 NOK");
    await expect(receiptRow).toContainText(RECEIPT_DATE);
    await expect(receiptRow).toContainText("Pending");

    const replayResponse = await request.post(`${RECEIPT_API_ORIGIN}/api/receipts/submit`, {
      headers: {
        Authorization: `Bearer ${activeToken()}`,
      },
      multipart: {
        commandId: stableCommandId,
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
    expect([200, 201]).toContain(replayResponse.status());
    const replay = receiptObservationSchema.parse(await replayResponse.json());
    expect(replay.commandId).toBe(stableCommandId);
    expect(replay.receiptId).toBe(renderedReceiptId);
    expect(replay.status).toBe("Pending");
    expect(replay.revision).toBe(0);
    expect(replay.replayed).toBe(true);

    const ownedResponse = await request.get(`${RECEIPT_API_ORIGIN}/api/receipts`, {
      headers: {
        Authorization: `Bearer ${activeToken()}`,
      },
    });
    expect(ownedResponse.status()).toBe(200);
    const owned = receiptPageSchema.parse(await ownedResponse.json());
    expect(owned.totalItems).toBe(1);
    expect(owned.items).toHaveLength(1);
    expect(owned.items[0]).toMatchObject({
      receiptId: renderedReceiptId,
      amountOre: AMOUNT_ORE,
      currency: "NOK",
      receiptDate: RECEIPT_DATE,
      status: "Pending",
      revision: 0,
    });

    await page.reload();
    receiptRow = page.getByRole("row").filter({ hasText: DESCRIPTION });
    await expect(receiptRow).toHaveCount(1);
    await expect(receiptRow.getByTestId("receipt-id")).toHaveText(replay.receiptId);

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
          rejectedInputs: [
            { tag: "ReceiptDecodeError", field: "amountNok" },
            { tag: "ReceiptDecodeError", field: "file" },
          ],
          accepted: {
            receiptId: replay.receiptId,
            visualId: replay.visualId,
            amountOre: AMOUNT_ORE,
            currency: "NOK",
            receiptDate: RECEIPT_DATE,
            status: replay.status,
            revision: replay.revision,
          },
          replay: {
            commandId: replay.commandId,
            receiptId: replay.receiptId,
            replayed: replay.replayed,
          },
          rendered: {
            receiptId: renderedReceiptId,
            amount: "125,50 NOK",
            receiptDate: RECEIPT_DATE,
            status: "Pending",
          },
        }),
      ),
      contentType: "application/json",
    });
  });
});
