import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { z } from "zod";

const APP_URL = "http://127.0.0.1:5174";
const STUB_URL = "http://127.0.0.1:8787";
const TOKEN = "trace-token";
const isConfigPrecheck = process.env.RECEIPT_CONFIG_PRECHECK === "1";

type FaultOptions = {
  status?: number;
  malformed?: "receipt-date" | "admin-shape" | "create-response";
};

async function resetStub(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${STUB_URL}/__receipt_stub/reset`);
  expect(response.status()).toBe(204);
}

async function setFault(
  request: APIRequestContext,
  operation:
    | "personal-list"
    | "personal-create"
    | "personal-update"
    | "personal-delete"
    | "admin-list"
    | "admin-status"
    | "profile",
  options: FaultOptions,
): Promise<void> {
  const response = await request.post(`${STUB_URL}/__receipt_stub/control`, {
    data: { operation, ...options },
  });
  expect(response.status()).toBe(204);
}

async function clearFault(
  request: APIRequestContext,
  operation:
    | "personal-list"
    | "personal-create"
    | "personal-update"
    | "personal-delete"
    | "admin-list"
    | "admin-status"
    | "profile",
): Promise<void> {
  const response = await request.post(`${STUB_URL}/__receipt_stub/control`, {
    data: { operation, clear: true },
  });
  expect(response.status()).toBe(204);
}

const receiptStubEvidenceSchema = z.object({
  requests: z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      status: z.number().int(),
      bodyShape: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("empty") }),
        z.object({ kind: z.literal("json"), keys: z.array(z.string()) }),
        z.object({
          kind: z.literal("multipart"),
          fields: z.array(z.string()),
          filePresent: z.boolean(),
        }),
      ]),
    }),
  ),
  transitions: z.array(z.string()),
});

async function readEvidence(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${STUB_URL}/__receipt_stub/evidence`);
  expect(response.status()).toBe(200);
  return response.text();
}

async function authenticate(page: Page): Promise<void> {
  await page.context().addCookies([
    {
      name: "jwt_token",
      value: TOKEN,
      url: APP_URL,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test.describe("Receipt SDK consumer seam", () => {
  // Preflight intentionally runs without the fixture:
  // env -u API_URL -u VITE_API_URL CI=1 RECEIPT_CONFIG_PRECHECK=1 node ./node_modules/@playwright/test/cli.js test e2e/receipts.spec.ts -g "isolated SSR configuration preflight" --project=chromium --retries=0
  // Journey starts `bun e2e/fixtures/receipt-api.ts --port 8787` first, then uses:
  // API_URL=http://127.0.0.1:8787 VITE_API_URL=http://127.0.0.1:8787 node ./node_modules/@playwright/test/cli.js test e2e/receipts.spec.ts -g "runs the personal and admin Receipt journey against the loopback stub" --project=chromium --retries=0
  test("isolated SSR configuration preflight", async ({ page }) => {
    test.skip(!isConfigPrecheck, "requires the isolated SSR config preflight command");
    await authenticate(page);
    const preflight = await page.request.get(
      `${APP_URL}/dashboard/mine-utlegg.data?_routes=routes%2Fdashboard.mine-utlegg._index`,
    );
    expect(preflight.status()).toBe(200);
    expect(await preflight.text()).toContain(
      "API-konfigurasjon mangler eller er ugyldig.",
    );
  });

  test("runs the personal and admin Receipt journey against the loopback stub", async ({
    page,
    request,
  }) => {
    test.skip(isConfigPrecheck, "separate isolated SSR config preflight");
    await resetStub(request);
    await authenticate(page);

    await page.goto("/dashboard/mine-utlegg");
    await expect(page.getByRole("heading", { name: "Mine Utlegg" })).toBeVisible();
    // Cold Vite route prebundle stabilization: dependency optimization can reload the DOM.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Mine Utlegg" })).toBeVisible();
    await expect(page.getByText("2026-08-08", { exact: true })).toBeVisible();
    await expect(page.getByText("Venter", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Legg til utlegg", exact: true }).click();
    const createDialog = page.getByRole("dialog");
    await createDialog.getByLabel(/Beskrivelse/).fill("Travel to course");
    await createDialog.getByLabel(/Beløp/).fill("125.50");
    await createDialog.getByLabel(/Dato/).fill("2026-08-08");
    await createDialog.getByLabel(/Kvitteringsbilde/).setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from("synthetic receipt"),
    });
    await createDialog.getByRole("button", { name: "Legg til", exact: true }).click();
    await expect(page.getByText("Travel to course", { exact: true })).toBeVisible();
    await createDialog.getByRole("button", { name: "Avbryt", exact: true }).click();
    await expect(
      page.getByRole("row").filter({ hasText: "Travel to course" }),
    ).toContainText("2026-08-08");

    let createdRow = page.getByRole("row").filter({ hasText: "Travel to course" });
    await createdRow.getByRole("button", { name: "Rediger", exact: true }).click();
    const editDialog = page.getByRole("dialog");
    await editDialog.getByLabel(/Beskrivelse/).fill("Travel updated");
    await editDialog.getByLabel(/Beløp/).fill("140.75");
    await editDialog.getByLabel(/Dato/).fill("2026-08-09");
    await editDialog
      .getByRole("button", { name: "Lagre endringer", exact: true })
      .click();
    await expect(page.getByText("Travel updated", { exact: true })).toBeVisible();
    await editDialog.getByRole("button", { name: "Avbryt", exact: true }).click();
    await expect(
      page.getByRole("row").filter({ hasText: "Travel updated" }),
    ).toContainText("2026-08-09");

    createdRow = page.getByRole("row").filter({ hasText: "Travel updated" });
    await createdRow.getByRole("button", { name: "Slett", exact: true }).click();
    const deleteDialog = page.getByRole("alertdialog");
    await deleteDialog.getByRole("button", { name: "Slett", exact: true }).click();
    await expect(page.getByText("Travel updated", { exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Refundert", exact: true }).click();
    await expect(page.getByText("Course travel", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Alle", exact: true }).click();
    await expect(page.getByText("Course travel", { exact: true })).toBeVisible();

    await page.goto("/dashboard/utlegg");
    await expect(page.getByRole("heading", { name: "Utlegg" })).toBeVisible();
    await expect(page.getByText("Kari Nordmann", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: "Approval receipt" }),
    ).toContainText("2026-08-05");

    await page.getByRole("button", { name: "Refundert", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard\/utlegg\?status=refunded/);
    await expect(page.getByText("Already refunded", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Alle", exact: true }).click();

    let adminRow = page.getByRole("row").filter({ hasText: "Approval receipt" });
    await adminRow.getByRole("button", { name: "Godkjenn", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Godkjenn", exact: true }).click();
    await expect(adminRow).toContainText("Refundert");

    adminRow = page.getByRole("row").filter({ hasText: "Rejection receipt" });
    await adminRow.getByRole("button", { name: "Avvis", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Avvis", exact: true }).click();
    await expect(adminRow).toContainText("Avvist");

    adminRow = page.getByRole("row").filter({ hasText: "Reopen receipt" });
    await adminRow.getByRole("button", { name: "Gjenåpne", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Gjenåpne", exact: true }).click();
    await expect(adminRow).toContainText("Venter");

    for (const status of [422, 404, 429, 500]) {
      await setFault(request, "personal-list", { status });
      await page.goto("/dashboard/mine-utlegg");
      await expect(page.getByRole("alert").first()).toBeVisible();
      await clearFault(request, "personal-list");
    }

    await page.goto("/dashboard/mine-utlegg");
    await setFault(request, "personal-create", { status: 422 });
    await page.getByRole("button", { name: "Legg til utlegg", exact: true }).click();
    const createErrorDialog = page.getByRole("dialog");
    await createErrorDialog.getByLabel(/Beskrivelse/).fill("Fault create");
    await createErrorDialog.getByLabel(/Beløp/).fill("10");
    await createErrorDialog.getByLabel(/Dato/).fill("2026-08-08");
    await createErrorDialog.getByLabel(/Kvitteringsbilde/).setInputFiles({
      name: "receipt.png",
      mimeType: "image/png",
      buffer: Buffer.from("synthetic receipt"),
    });
    await createErrorDialog.getByRole("button", { name: "Legg til", exact: true }).click();
    await expect(createErrorDialog.getByRole("alert")).toBeVisible();
    await clearFault(request, "personal-create");
    await createErrorDialog.getByRole("button", { name: "Avbryt", exact: true }).click();

    await page.goto("/dashboard/mine-utlegg");
    await setFault(request, "personal-update", { status: 409 });
    const updateErrorRow = page.getByRole("row").filter({ hasText: "Course travel" });
    await updateErrorRow.getByRole("button", { name: "Rediger", exact: true }).click();
    const updateErrorDialog = page.getByRole("dialog");
    await updateErrorDialog.getByLabel(/Beskrivelse/).fill("Fault update");
    await updateErrorDialog.getByLabel(/Beløp/).fill("11");
    await updateErrorDialog.getByLabel(/Dato/).fill("2026-08-08");
    await updateErrorDialog
      .getByRole("button", { name: "Lagre endringer", exact: true })
      .click();
    await expect(updateErrorDialog.getByRole("alert")).toBeVisible();
    await clearFault(request, "personal-update");
    await updateErrorDialog.getByRole("button", { name: "Avbryt", exact: true }).click();

    await setFault(request, "personal-list", { malformed: "receipt-date" });
    await page.goto("/dashboard/mine-utlegg");
    await expect(page.getByRole("alert").first()).toBeVisible();
    await clearFault(request, "personal-list");

    await page.goto("/dashboard/mine-utlegg");
    const initialRow = page.getByRole("row").filter({ hasText: "Course travel" });
    await setFault(request, "personal-delete", { status: 409 });
    await initialRow.getByRole("button", { name: "Slett", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Slett", exact: true }).click();
    await expect(page.getByRole("alertdialog").getByRole("alert")).toBeVisible();
    await clearFault(request, "personal-delete");
    await page.getByRole("alertdialog").getByRole("button", { name: "Avbryt", exact: true }).click();

    await page.goto("/dashboard/utlegg");
    await setFault(request, "admin-status", { status: 409 });
    const statusErrorRow = page.getByRole("row").filter({ hasText: "Rejection receipt" });
    await statusErrorRow.getByRole("button", { name: "Gjenåpne", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Gjenåpne", exact: true }).click();
    await expect(statusErrorRow.getByRole("alert")).toBeVisible();
    await clearFault(request, "admin-status");

    await setFault(request, "admin-list", { malformed: "admin-shape" });
    await page.goto("/dashboard/utlegg");
    await expect(page.getByRole("alert").first()).toBeVisible();
    await clearFault(request, "admin-list");

    await setFault(request, "personal-list", { status: 401 });
    const expired = await page.request.get(`${APP_URL}/dashboard/mine-utlegg`, {
      maxRedirects: 0,
    });
    expect(expired.status()).toBe(302);
    expect(expired.headers().location).toContain("/login?expired=true");
    await clearFault(request, "personal-list");

    const rawEvidence = await readEvidence(request);
    expect(rawEvidence).not.toContain(TOKEN);
    expect(rawEvidence).not.toContain("Travel to course");
    await test.info().attach("receipt-stub-evidence.json", {
      body: Buffer.from(rawEvidence),
      contentType: "application/json",
    });
    const stubEvidence = receiptStubEvidenceSchema.parse(JSON.parse(rawEvidence));

    expect(stubEvidence.transitions).toEqual(
      expect.arrayContaining([
        "personal:create:99",
        "personal:update:99",
        "personal:delete:99",
        "admin:10:refunded",
        "admin:11:rejected",
        "admin:12:pending",
      ]),
    );
    expect(stubEvidence.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "POST", path: "/api/receipts", status: 201 }),
        expect.objectContaining({ method: "PUT", path: "/api/receipts/99", status: 204 }),
        expect.objectContaining({ method: "DELETE", path: "/api/receipts/99", status: 204 }),
        expect.objectContaining({ method: "GET", path: "/api/admin/receipts" }),
        expect.objectContaining({
          method: "PUT",
          path: "/api/admin/receipts/10/status",
          status: 204,
        }),
      ]),
    );

    const createRequest = stubEvidence.requests.find(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/receipts" &&
        request.status === 201,
    );
    expect(createRequest).toBeDefined();
    if (createRequest === undefined || createRequest.bodyShape.kind !== "multipart") {
      throw new Error("Receipt create evidence is not multipart");
    }
    expect(createRequest.bodyShape.filePresent).toBe(true);
    expect(createRequest.bodyShape.fields).toEqual(
      expect.arrayContaining(["description", "sum", "receiptDate", "file"]),
    );
    expect(createRequest.bodyShape.fields).not.toContain("picture");

  });
});
