import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Predicate } from "effect";
import { fixture, receiptBytes } from "../../../tools/e2e/golden-reimbursement-evidence.mjs";
import { sha256 } from "../../../tools/e2e/golden-school-service-evidence.mjs";

export const runReimbursementBrowser = async ({
  origins,
  persons,
  artifacts,
  checkpoint,
  eventually,
  readFacts,
  restart,
  providerMode,
  fault,
  browserReady,
}) => {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
      "/etc/profiles/per-user/nori/bin/chromium-browser",
    args: process.env.GOLDEN_BROWSER_CDP_PORT
      ? [`--remote-debugging-port=${process.env.GOLDEN_BROWSER_CDP_PORT}`]
      : [],
  });

  browserReady(browser);
  const checks = [];
  const sessions = [];

  const request = (cookie, path, options = {}) =>
    fetch(origins.backend + path, {
      ...options,
      headers: { cookie, origin: origins.dashboard, ...options.headers },
      signal: AbortSignal.timeout(15_000),
    });

  const json = async (response, status) => {
    const body = await response.json();
    assert.equal(response.status, status, `HTTP status ${JSON.stringify(body)}`);

    return body;
  };

  const problem = async (response, status, code) => {
    const body = await json(response, status);
    assert.equal(body.code, code);
    checks.push({ kind: "denial", status, code });
  };

  const login = async (role) => {
    const person = persons[role];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    sessions.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.goto(origins.dashboard + "/dashboard/login");
    await page.getByLabel("E-post").fill(person.email);
    await page.getByLabel("Passord", { exact: true }).fill(person.password);
    await page.getByRole("button", { name: "Logg inn", exact: true }).press("Enter");
    await page.waitForURL((url) => /^\/dashboard\/?$/.test(url.pathname));

    const cookies = (await context.cookies()).filter(({ name }) =>
      name.endsWith("better-auth.session_token"),
    );

    assert.equal(cookies.length, 1);
    const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
    const session = await json(await request(cookie, "/api/session"), 200);
    assert.equal(session.personId, person.personId);
    checks.push({ kind: "session", role, personId: session.personId });

    return { page, cookie, context };
  };

  const inspect = async (page, surface) => {
    for (const [layout, width] of [
      ["desktop", 1280],
      ["narrow", 390],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: join(artifacts, `${surface}-${layout}.png`), fullPage: true });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `${surface} page overflow`,
      );
      const audit = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();

      const serious = audit.violations.filter(
        ({ impact }) => impact === "serious" || impact === "critical",
      );

      assert.deepEqual(
        serious.map(({ id }) => id),
        [],
        `${surface} accessibility`,
      );
      checks.push({ kind: "surface", surface, layout, width, seriousViolations: 0 });
    }

    await page.setViewportSize({ width: 1280, height: 900 });
  };

  const list = async (actor, path) => json(await request(actor.cookie, path), 200);

  const command = (actor, receiptId, action, key, etag, body = {}) =>
    request(actor.cookie, `/api/receipts/${encodeURIComponent(receiptId)}:${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key, "if-match": etag },
      body: JSON.stringify(body),
    });

  const allDelivered = () =>
    eventually(
      "receipt effects delivered",
      async () => (await readFacts()).outbox.every(({ status }) => status === "Delivered"),
      120000,
    );

  try {
    const owner = await login("owner");
    await owner.page.goto(origins.dashboard + "/dashboard/mine-utlegg");
    const form = owner.page.getByRole("form", { name: "Send inn utlegg" });
    await form.getByLabel(/Beskrivelse/).fill(fixture.description);
    await form.locator("#amountNok").fill("125,50");
    await form.getByLabel(/Kvitteringsdato/).fill(fixture.receiptDate);
    await form
      .getByLabel(/Kvitteringsfil/)
      .setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: receiptBytes });
    await form.getByRole("button", { name: "Send inn utlegg", exact: true }).press("Enter");
    await expect(owner.page.locator("[data-command-id]")).toBeVisible();
    const submitKey = await owner.page.locator("[data-command-id]").getAttribute("data-command-id");

    const pending = (await list(owner, "/api/receipts")).items.find(
      ({ description }) => description === fixture.description,
    );

    assert.ok(pending);
    const receiptId = pending.receiptId;
    await allDelivered();
    await checkpoint("submitted", { receiptId });
    await inspect(owner.page, "owner");

    if (fault === "after-submitted") throw new Error("Injected journey failure after submitted");

    if (fault === "interrupt-after-submitted") process.kill(process.pid, "SIGTERM");

    const repeatSubmission = async () => {
      const payload = new FormData();
      payload.set("description", fixture.description);
      payload.set("amountOre", String(fixture.amountOre));
      payload.set("receiptDate", fixture.receiptDate);
      payload.set("file", new File([receiptBytes], "receipt.png", { type: "image/png" }));

      return json(
        await request(owner.cookie, "/api/receipts", {
          method: "POST",
          headers: { "idempotency-key": submitKey },
          body: payload,
        }),
        201,
      );
    };

    const repeats = await Promise.all([repeatSubmission(), repeatSubmission()]);

    for (const repeated of repeats) assert.equal(repeated.receiptId, receiptId);
    await owner.page.reload();
    await expect(owner.page.locator(`tr[data-receipt-id="${receiptId}"]`)).toHaveCount(1);
    await checkpoint("submission-replay");

    const other = await login("other");
    const wrong = await login("wrongScope");

    for (const actor of [other, wrong]) {
      assert.equal(
        (await list(actor, "/api/receipts")).items.some((row) => row.receiptId === receiptId),
        false,
      );
      await problem(
        await request(actor.cookie, `/api/receipts/${receiptId}/file`),
        404,
        "resource.not-found",
      );
    }

    await problem(
      await request(wrong.cookie, `/api/receipt-approval-queue/${receiptId}/file`),
      403,
      "authority.denied",
    );
    await problem(
      await command(wrong, receiptId, "approve", randomUUID(), pending.etag),
      403,
      "authority.denied",
    );
    await checkpoint("private-denials");
    const beforeRestart = await request(owner.cookie, `/api/receipts/${receiptId}/file`);
    assert.equal(beforeRestart.status, 200);
    assert.equal(sha256(Buffer.from(await beforeRestart.arrayBuffer())), sha256(receiptBytes));
    await restart();
    const afterRestart = await request(owner.cookie, `/api/receipts/${receiptId}/file`);
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.headers.get("cache-control"), "private, no-store");
    assert.equal(sha256(Buffer.from(await afterRestart.arrayBuffer())), sha256(receiptBytes));
    await problem(
      await request(other.cookie, `/api/receipts/${receiptId}/file`),
      404,
      "resource.not-found",
    );
    await checkpoint("restart-custody");

    const approver = await login("approver");
    await approver.page.goto(origins.dashboard + "/dashboard/utlegg?status=Pending");
    const approvalRow = approver.page.locator(`tr[data-receipt-id="${receiptId}"]`);
    await expect(approvalRow).toBeVisible();
    const receiptLink = approvalRow.getByRole("link", { name: "Vis kvittering", exact: true });
    const fileUrl = new URL(await receiptLink.getAttribute("href"), origins.dashboard).href;

    const fileResponse = approver.context.waitForEvent("response", {
      predicate: (response) => response.url() === fileUrl,
    });

    const popupPromise = approver.page.waitForEvent("popup");
    await receiptLink.click();
    const [popup, downloaded] = await Promise.all([popupPromise, fileResponse]);
    await popup.waitForURL(fileUrl);
    assert.equal(downloaded.status(), 200);
    assert.equal(sha256(await downloaded.body()), sha256(receiptBytes));
    await popup.close();
    await inspect(approver.page, "approver");
    providerMode("timeout");
    await approvalRow.getByRole("button", { name: "Godkjenn", exact: true }).press("Enter");
    const approvalForm = approver.page.locator('form[data-receipt-resolution="approve"]');
    const approvalKey = await approvalForm.locator('[name="commandId"]').inputValue();
    await approver.page.screenshot({ path: join(artifacts, "approval-confirmation.png") });
    await approvalForm
      .getByRole("button", { name: "Bekreft godkjenning", exact: true })
      .press("Enter");
    await eventually("failed approval notification", async () =>
      (await readFacts()).outbox.some(
        ({ effect_type, status, attempts }) =>
          effect_type === "NotifyReceiptApproved" && status === "Failed" && attempts > 0,
      ),
    );
    await checkpoint("approval-failed-delivery");

    const approved = (await list(owner, "/api/receipts")).items.find(
      (row) => row.receiptId === receiptId,
    );

    assert.equal(approved.status, "Approved");
    assert.equal(approved.settlement, null);

    for (const response of await Promise.all([
      command(approver, receiptId, "approve", approvalKey, pending.etag),
      command(approver, receiptId, "approve", approvalKey, pending.etag),
    ]))
      assert.equal((await json(response, 200)).receiptId, receiptId);
    await problem(
      await command(approver, receiptId, "reject", randomUUID(), pending.etag),
      412,
      "precondition.failed",
    );
    await checkpoint("approval-replay-stale");

    const settlementBody = {
      expectedRevision: 1,
      externalAuthority: fixture.externalAuthority,
      externalReference: fixture.externalReference,
      settledAt: fixture.settledAt,
    };

    await problem(
      await command(approver, receiptId, "settle", randomUUID(), approved.etag, settlementBody),
      404,
      "receipt.not-found",
    );
    await checkpoint("settlement-authority-denial");
    providerMode("accept");
    await allDelivered();
    await checkpoint("unattended-recovery");

    const finance = await login("finance");
    await finance.page.goto(origins.dashboard + "/dashboard/utlegg/oppgjor");
    const settlementRow = finance.page.locator(`tr[data-receipt-id="${receiptId}"]`);
    await expect(settlementRow).toBeVisible();
    await inspect(finance.page, "finance");
    await settlementRow
      .getByRole("button", { name: "Registrer oppgjør", exact: true })
      .press("Enter");
    const settlementForm = finance.page.locator('form[data-receipt-settlement="record"]');
    await settlementForm
      .getByLabel("Ekstern autoritet", { exact: true })
      .fill(fixture.externalAuthority);
    await settlementForm
      .getByLabel("Ekstern referanse", { exact: true })
      .fill(fixture.externalReference);
    await settlementForm
      .getByLabel("Oppgjørstidspunkt (UTC)", { exact: true })
      .fill("2026-09-21T10:00");
    const settlementKey = await settlementForm.locator('[name="commandId"]').inputValue();
    await finance.page.screenshot({ path: join(artifacts, "settlement-confirmation.png") });
    await settlementForm
      .getByRole("button", { name: "Bekreft oppgjør", exact: true })
      .press("Enter");
    await eventually(
      "settlement committed",
      async () => (await readFacts()).settlements.length === 1,
    );

    const settled = (await list(owner, "/api/receipts")).items.find(
      (row) => row.receiptId === receiptId,
    );

    assert.ok(settled.settlement);
    await allDelivered();
    await checkpoint("settled", { settlementId: settled.settlement.settlementId });

    for (const response of await Promise.all([
      command(finance, receiptId, "settle", settlementKey, approved.etag, settlementBody),
      command(finance, receiptId, "settle", settlementKey, approved.etag, settlementBody),
    ]))
      assert.equal((await json(response, 200)).settlementId, settled.settlement.settlementId);
    await problem(
      await command(finance, receiptId, "settle", randomUUID(), approved.etag, settlementBody),
      412,
      "precondition.failed",
    );
    await checkpoint("settlement-replay-stale");
    await owner.context.close();
    const fresh = await login("owner");
    await fresh.page.goto(origins.dashboard + "/dashboard/mine-utlegg");
    await expect(
      fresh.page.locator(`section[data-settlement-id="${settled.settlement.settlementId}"]`),
    ).toContainText(fixture.externalReference);
    await expect(
      fresh.page
        .locator(`tr[data-receipt-id="${receiptId}"]`)
        .first()
        .locator('[data-status="Approved"]'),
    ).toBeVisible();
    await fresh.page.reload();
    await expect(
      fresh.page.locator(`section[data-settlement-id="${settled.settlement.settlementId}"]`),
    ).toContainText(fixture.externalAuthority);
    await fresh.page.screenshot({ path: join(artifacts, "fresh-owner.png"), fullPage: true });
    await checkpoint("fresh-owner");
    const beforeBounds = await readFacts();
    const tooLarge = new FormData();
    tooLarge.set("_intent", "submit");
    tooLarge.set("commandId", randomUUID());
    tooLarge.set("description", "Rejected oversized transfer");
    tooLarge.set("amountNok", "1");
    tooLarge.set("receiptDate", fixture.receiptDate);
    tooLarge.set(
      "file",
      new File([new Uint8Array(10 * 1024 * 1024 + 131073)], "oversized.png", { type: "image/png" }),
    );

    const oversized = await fetch(origins.dashboard + "/dashboard/mine-utlegg", {
      method: "POST",
      headers: { cookie: fresh.cookie, origin: origins.dashboard },
      body: tooLarge,
      signal: AbortSignal.timeout(15000),
    });

    assert.equal(oversized.status, 413);
    await oversized.body?.cancel();
    assert.deepEqual(await readFacts(), beforeBounds, "oversized intake changed persisted state");
    checks.push({ kind: "intake", bytes: 10 * 1024 * 1024 + 131073, status: 413, unchanged: true });
    await restart("disabled");
    const opaqueBytes = Buffer.from([0, 255, 17, 42]);

    const submitBounded = async (index) => {
      const payload = new FormData();
      payload.set("description", `Bounded traversal ${index}`);
      payload.set("amountOre", "100");
      payload.set("receiptDate", fixture.receiptDate);
      payload.set(
        "file",
        new File([index === 0 ? opaqueBytes : receiptBytes], "receipt.png", { type: "image/png" }),
      );

      return json(
        await request(fresh.cookie, "/api/receipts", {
          method: "POST",
          headers: { "idempotency-key": randomUUID() },
          body: payload,
        }),
        201,
      );
    };

    const concurrent = await Promise.all([submitBounded(0), submitBounded(1)]);

    for (const [index, result] of concurrent.entries()) {
      const file = await request(fresh.cookie, `/api/receipts/${result.receiptId}/file`);
      assert.equal(file.status, 200);
      assert.equal(
        sha256(Buffer.from(await file.arrayBuffer())),
        sha256(index === 0 ? opaqueBytes : receiptBytes),
      );
    }

    checks.push({
      kind: "concurrent-disabled-worker",
      receipts: concurrent.map(({ receiptId }) => receiptId),
      authorizedBytes: true,
      opaqueLeadingNulPreserved: true,
    });

    for (let index = 2; index < 51; index++) await submitBounded(index);
    const pendingBounds = [];

    for (const [actor, path, expected] of [
      [fresh, "/api/receipts", 52],
      [approver, "/api/receipt-approval-queue?status=Pending", 51],
    ]) {
      const ids = [];
      const sizes = [];
      let cursor;

      do {
        assert.ok(sizes.length < 3, "collection traversal did not terminate");

        const page = await list(
          actor,
          path +
            (cursor === undefined
              ? ""
              : `${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`),
        );

        assert.ok(page.items.length <= 50, "collection page exceeds bound");
        sizes.push(page.items.length);
        ids.push(...page.items.map(({ receiptId }) => receiptId));

        if (actor === approver) pendingBounds.push(...page.items);
        assert.ok(
          page.nextCursor === undefined || Predicate.isString(page.nextCursor),
          "collection continuation required",
        );
        cursor = page.nextCursor;
      } while (cursor !== undefined);

      assert.equal(ids.length, expected);
      assert.equal(new Set(ids).size, expected);
      checks.push({
        kind: "bounded-collection",
        path,
        pageSizes: sizes,
        total: expected,
        duplicates: 0,
      });
    }

    const inspectPagination = async (actor, path, total) => {
      await actor.page.goto(origins.dashboard + path);
      const rows = actor.page.locator("tr[data-receipt-id]:not([data-settlement-id])");
      await expect(rows).toHaveCount(50);

      const first = await rows.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-receipt-id")),
      );

      const nav = actor.page.getByRole("navigation", { name: "Sider i utleggslisten" });
      await nav.getByRole("link", { name: "Neste side", exact: true }).click();
      await expect(rows).toHaveCount(total - 50);

      const second = await rows.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-receipt-id")),
      );

      assert.equal(new Set([...first, ...second]).size, total);
      await actor.page.screenshot({
        path: join(
          artifacts,
          `pagination-${path.includes("oppgjor") ? "finance" : path.includes("mine-utlegg") ? "owner" : "approval"}.png`,
        ),
        fullPage: true,
      });
      await nav.getByRole("link", { name: "Første side", exact: true }).click();
      await expect(rows).toHaveCount(50);
      assert.deepEqual(
        await rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-receipt-id")),
        ),
        first,
      );
      checks.push({
        kind: "pagination-ui",
        path,
        total,
        pageSizes: [50, total - 50],
        nextAndFirst: true,
      });
    };

    await inspectPagination(fresh, "/dashboard/mine-utlegg", 52);
    await inspectPagination(approver, "/dashboard/utlegg?status=Pending", 51);

    for (const receipt of pendingBounds)
      await json(
        await command(approver, receipt.receiptId, "approve", randomUUID(), receipt.etag),
        200,
      );
    await inspectPagination(finance, "/dashboard/utlegg/oppgjor", 51);
    const boundedFacts = await readFacts();
    assert.equal(boundedFacts.receipts.length, 52);
    assert.equal(boundedFacts.commands.length, 105);
    assert.equal(
      boundedFacts.outbox.filter(
        ({ effect_type, status }) => effect_type === "PromoteReceiptFile" && status === "Delivered",
      ).length,
      52,
    );
    assert.ok(
      boundedFacts.outbox.some(({ status }) => status === "Failed"),
      "disabled provider must retain pending work",
    );
    providerMode("accept");
    await restart();
    await allDelivered();
    const recoveredFacts = await readFacts();
    assert.equal(recoveredFacts.outbox.length, boundedFacts.outbox.length);
    assert.equal(recoveredFacts.commands.length, 105);
    checks.push({
      kind: "disabled-worker-recovery",
      pendingPreserved: true,
      allDelivered: true,
      receiptCount: 52,
      outboxCount: recoveredFacts.outbox.length,
    });

    return { passed: true, receiptId, settlementId: settled.settlement.settlementId, checks };
  } finally {
    await browser.close();
    await writeFile(join(artifacts, "browser-checks.json"), JSON.stringify({ checks }, null, 2), {
      mode: 0o600,
    });
  }
};
