/** 0102: extends the owned 0095/0097 runtime, sharing their local acknowledged transport. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Pool } from "pg";
import { Schema } from "effect";
import { ReceiptResource } from "../../http-api/src/index.js";
import { StrongETag, IdempotencyKey } from "../../http-api/src/http-semantics.js";
import { createPromiseClient } from "../../sdk/src/promise.js";

export async function observeReceiptReopening(options: {
  pool: Pool;
  origin: string;
  cookie: string;
  approverCookie: string;
  root: string;
  artifactDirectory: string;
  attempts: () => number;
  accepted: () => number;
  setDeliveryAvailable: (available: boolean) => void;
}) {
  const { pool, origin, cookie, approverCookie } = options;
  const dashboardOrigin = "http://127.0.0.1:5174";
  const client = createPromiseClient(origin, { cookie: approverCookie, origin: dashboardOrigin });
  const headers = (session: string, etag?: string, key: string = randomUUID()) => ({
    cookie: session,
    origin: dashboardOrigin,
    "content-type": "application/json",
    "idempotency-key": key,
    ...(etag ? { "if-match": etag } : {}),
  });
  const request = (
    id: string,
    action: string,
    etag?: string,
    session = approverCookie,
    key: string = randomUUID(),
    body = "{}",
  ) =>
    fetch(`${origin}/api/receipts/${id}:${action}`, {
      method: "POST",
      headers: headers(session, etag, key),
      body,
    });
  const row = async (id: string) =>
    (await pool.query("SELECT * FROM economy_receipts WHERE receipt_id=$1", [id])).rows[0];
  const snapshot = async (id: string) => ({
    receipt: await row(id),
    audit: (
      await pool.query(
        "SELECT * FROM economy_receipt_audit WHERE receipt_id=$1 ORDER BY receipt_revision",
        [id],
      )
    ).rows,
    commands: (
      await pool.query(
        "SELECT * FROM economy_receipt_command_receipts WHERE receipt_id=$1 ORDER BY command_id",
        [id],
      )
    ).rows,
    outbox: (
      await pool.query(
        "SELECT * FROM economy_receipt_outbox WHERE receipt_id=$1 ORDER BY effect_id",
        [id],
      )
    ).rows,
  });
  const submit = async () => {
    const form = new FormData();
    form.set("description", "Synthetic correction 0102");
    form.set("amountOre", "500");
    form.set("receiptDate", "2026-09-06");
    form.set(
      "file",
      new File(["%PDF-1.4\nSynthetic 0102\n%%EOF"], "receipt.pdf", { type: "application/pdf" }),
    );
    const response = await fetch(`${origin}/api/receipts?departmentId=receipt-department-0095`, {
      method: "POST",
      headers: { cookie, origin: dashboardOrigin, "idempotency-key": randomUUID() },
      body: form,
    });
    assert.equal(response.status, 201, "synthetic submission");
    const resource = Schema.decodeUnknownSync(ReceiptResource)(await response.json());
    return { id: resource.receiptId, etag: resource.etag };
  };
  const rejected = async () => {
    const receipt = await submit();
    const response = await request(receipt.id, "reject", receipt.etag);
    assert.equal(response.status, 200);
    return {
      ...receipt,
      initialEtag: receipt.etag,
      etag: Schema.decodeUnknownSync(StrongETag)(response.headers.get("etag")),
    };
  };
  options.setDeliveryAvailable(false);
  const target = await rejected();
  options.setDeliveryAvailable(true);
  const before = await snapshot(target.id);
  assert.ok(before.outbox.some((item: any) => item.status === "Failed"));
  const attemptsBefore = options.attempts();
  // Invalid commands must have no persisted footprint.
  for (const [name, response, expected] of [
    ["owner", await request(target.id, "reopen", target.etag, cookie), 403],
    ["missing revision", await request(target.id, "reopen"), 428],
    ["stale revision", await request(target.id, "reopen", target.initialEtag), 412],
    [
      "extra authority",
      await request(
        target.id,
        "reopen",
        target.etag,
        approverCookie,
        randomUUID(),
        '{"actor":{"approvalScope":"Global"}}',
      ),
      422,
    ],
  ] as const)
    assert.equal(response.status, expected, name);
  assert.deepEqual(await snapshot(target.id), before);
  for (const mutation of [
    "UPDATE economy_receipt_approval_grants SET end_at=now(),revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
    "UPDATE organization_memberships SET end_at=now() WHERE membership_id='receipt0097-approver-membership'",
  ]) {
    await pool.query(mutation);
    assert.equal((await request(target.id, "reopen", target.etag)).status, 403);
    await pool.query(
      "UPDATE economy_receipt_approval_grants SET end_at=NULL,revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
    );
    await pool.query(
      "UPDATE organization_memberships SET end_at=NULL WHERE membership_id='receipt0097-approver-membership'",
    );
  }
  await pool.query(
    "INSERT INTO organization_departments(department_id,name,short_name,email,city,active) VALUES ('receipt-wrong-0102','Wrong0102','Wrong0102','wrong0102@example.invalid','Synthetic',true)",
  );
  await pool.query(
    "UPDATE economy_receipt_approval_grants SET department_id='receipt-wrong-0102',revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
  );
  assert.equal((await request(target.id, "reopen", target.etag)).status, 403);
  await pool.query(
    "UPDATE economy_receipt_approval_grants SET department_id='receipt-department-0095',revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
  );
  // Real database failure after mutation but before commit must roll the entire command back.
  await pool.query(
    "CREATE FUNCTION fail_reopen_0102() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='RejectedReceiptReopened' THEN RAISE EXCEPTION 'synthetic0102'; END IF; RETURN NEW; END $$",
  );
  await pool.query(
    "CREATE TRIGGER fail_reopen_0102 BEFORE INSERT ON economy_receipt_audit FOR EACH ROW EXECUTE FUNCTION fail_reopen_0102()",
  );
  const retryKey = IdempotencyKey.make(randomUUID());
  assert.equal(
    (await request(target.id, "reopen", target.etag, approverCookie, retryKey)).status,
    503,
  );
  assert.deepEqual(await snapshot(target.id), before);
  await pool.query("DROP TRIGGER fail_reopen_0102 ON economy_receipt_audit");
  await pool.query("DROP FUNCTION fail_reopen_0102()");
  const reopened = await client.receipts.reopenReceipt({
    params: { receiptId: target.id },
    headers: { "if-match": target.etag, "idempotency-key": retryKey },
    payload: {},
  });
  assert.equal(reopened.body.status, "Pending");
  const after = await snapshot(target.id);
  assert.deepEqual(after.receipt, {
    ...before.receipt,
    status: "Pending",
    revision: before.receipt.revision + 1,
  });
  assert.equal(after.audit.length, before.audit.length + 1);
  assert.equal(after.commands.length, before.commands.length + 1);
  assert.deepEqual(after.outbox, before.outbox);
  assert.equal(options.attempts(), attemptsBefore);
  const replay = await client.receipts.reopenReceipt({
    params: { receiptId: target.id },
    headers: { "if-match": target.etag, "idempotency-key": retryKey },
    payload: {},
  });
  assert.deepEqual(replay.body, reopened.body);
  assert.deepEqual(await snapshot(target.id), after);
  assert.equal(
    (await request(target.id, "reopen", reopened.body.etag, approverCookie, retryKey)).status,
    409,
  );
  await pool.query(
    "UPDATE economy_receipt_approval_grants SET end_at=now(),revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
  );
  assert.equal(
    (await request(target.id, "reopen", target.etag, approverCookie, retryKey)).status,
    403,
  );
  await pool.query(
    "UPDATE economy_receipt_approval_grants SET end_at=NULL,revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
  );
  assert.equal((await request(target.id, "reopen", reopened.body.etag)).status, 409);
  const race = await rejected();
  const results = await Promise.all([
    request(race.id, "reopen", race.etag),
    request(race.id, "reopen", race.etag),
  ]);
  const concurrentStatuses = results.map((r) => r.status).sort();
  assert.equal(concurrentStatuses.filter((status) => status === 200).length, 1);
  assert.ok(
    concurrentStatuses
      .filter((status) => status !== 200)
      .every((status) => status === 412 || status === 503),
  );
  assert.equal(
    Number(
      (
        await pool.query(
          "SELECT count(*) FROM economy_receipt_audit WHERE receipt_id=$1 AND action='RejectedReceiptReopened'",
          [race.id],
        )
      ).rows[0].count,
    ),
    1,
  );
  assert.equal((await request(race.id, "refund", race.etag)).status, 412);
  for (const action of ["refund", "withdraw"]) {
    const receipt = await submit();
    const closed = await request(
      receipt.id,
      action,
      receipt.etag,
      action === "withdraw" ? cookie : approverCookie,
    );
    assert.equal(closed.status, 200);
    const closedBefore = await snapshot(receipt.id);
    assert.equal((await request(receipt.id, "reopen", closed.headers.get("etag")!)).status, 409);
    assert.deepEqual(await snapshot(receipt.id), closedBefore);
  }
  // Browser journey uses real sessions from this driver's native sign-in and the built dashboard.
  const browserTarget = await rejected();
  const browserBefore = await snapshot(browserTarget.id);
  const requireDashboard = createRequire(join(options.root, "apps/dashboard/package.json"));
  const { chromium, expect } = requireDashboard("@playwright/test");
  const { default: AxeBuilder } = requireDashboard("@axe-core/playwright");
  const checkAxe = async (page: any, gate: string) => {
    await page.evaluate(async () => {
      const { document } = globalThis as unknown as {
        document: { getAnimations: () => Array<{ finished: Promise<unknown> }> };
      };
      await Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
    });
    const violations = (await new AxeBuilder({ page }).analyze()).violations.map((v: any) => ({
      id: v.id,
      nodes: v.nodes.map((node: any) => ({ target: node.target, summary: node.failureSummary })),
    }));
    if (violations.length > 0) {
      await page.screenshot({
        path: join(options.artifactDirectory, "0102-browser-failure.png"),
        fullPage: true,
      });
      throw new Error(JSON.stringify({ gate, violations }));
    }
  };
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(5174, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const dashboard = spawn("bun", ["server.mjs"], {
    cwd: join(options.root, "apps/dashboard"),
    env: {
      ...process.env,
      API_URL: origin,
      VITE_API_URL: origin,
      DASHBOARD_ORIGIN: dashboardOrigin,
      DASHBOARD_MOUNT: "/",
      HOST: "127.0.0.1",
      PORT: "5174",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const startupDiagnostics: string[] = [];
  dashboard.stderr?.on("data", (chunk) => {
    startupDiagnostics.push(String(chunk));
    if (startupDiagnostics.length > 20) startupDiagnostics.shift();
  });
  let browser: any;
  const errors: string[] = [];
  const mutations: Array<{ path: string; status: number }> = [];
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try {
        if ((await fetch(`${dashboardOrigin}/logg-inn`)).status < 500) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      ready,
      `production dashboard startup: exit=${dashboard.exitCode}; ${startupDiagnostics.join("").slice(-4000)}`,
    );
    browser = await chromium.launch({
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
        "/etc/profiles/per-user/nori/bin/chromium-browser",
      headless: true,
    });
    const context = async (session: string) => {
      const value = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const equals = session.indexOf("=");
      await value.addCookies([
        {
          name: session.slice(0, equals),
          value: session.slice(equals + 1),
          url: dashboardOrigin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const page = await value.newPage();
      page.on("response", (response: any) => {
        if (response.request().method() === "POST")
          mutations.push({ path: new URL(response.url()).pathname, status: response.status() });
      });
      page.on("pageerror", () => errors.push("browser runtime error"));
      page.on("console", (message: any) => {
        if (message.type() === "error") errors.push("browser console error");
      });
      return page;
    };
    const ownerPage = await context(cookie),
      approverPage = await context(approverCookie);
    const ownedRow = ownerPage.locator(`tr[data-receipt-id="${browserTarget.id}"]`);
    await ownerPage.goto(`${dashboardOrigin}/dashboard/mine-utlegg`);
    await expect(ownedRow.locator('[data-status="Rejected"]')).toBeVisible();
    await expect(ownedRow.getByRole("button", { name: "Rediger", exact: true })).toHaveCount(0);
    await approverPage.goto(`${dashboardOrigin}/dashboard/utlegg?status=Rejected`);
    const approvalRow = approverPage.locator(`tr[data-receipt-id="${browserTarget.id}"]`);
    await expect(approvalRow).toBeVisible();
    const button = approvalRow.getByRole("button", { name: "Åpne for korrigering", exact: true });
    await button.focus();
    await approverPage.keyboard.press("Enter");
    await expect(approverPage.getByRole("alertdialog")).toBeVisible();
    await checkAxe(approverPage, "approval accessibility");
    await approverPage.screenshot({
      path: join(options.artifactDirectory, "0102-reopen-mobile.png"),
      fullPage: true,
    });
    const browserAttempts = options.attempts();
    await approverPage.getByRole("button", { name: "Bekreft gjenåpning", exact: true }).click();
    try {
      await expect(
        approverPage.locator('[role="status"][data-action-intent="reopen"]'),
      ).toContainText("åpnet for korrigering");
    } catch {
      await approverPage.screenshot({
        path: join(options.artifactDirectory, "0102-browser-failure.png"),
        fullPage: true,
      });
      throw new Error(
        JSON.stringify({
          gate: "browser reopen confirmation",
          mutations,
          alerts: await approverPage.locator('[role="alert"]').allTextContents(),
          path: new URL(approverPage.url()).pathname,
          sqlState: (await row(browserTarget.id)).status,
          browserErrors: errors,
        }),
      );
    }
    await expect(approvalRow).toHaveCount(0);
    assert.equal(options.attempts(), browserAttempts);
    const browserReopened = await snapshot(browserTarget.id);
    assert.deepEqual(browserReopened.receipt, {
      ...browserBefore.receipt,
      status: "Pending",
      revision: 2,
    });
    assert.deepEqual(browserReopened.outbox, browserBefore.outbox);
    await ownerPage.reload();
    await ownedRow.getByRole("button", { name: "Rediger", exact: true }).click();
    const edit = ownerPage
      .locator('[data-receipt-form="revise"]')
      .filter({ has: ownerPage.locator(`input[name="receiptId"][value="${browserTarget.id}"]`) });
    await edit.locator('[name="description"]').fill("Corrected same claim 0102");
    await edit.locator('[name="amountNok"]').fill("6,00");
    await checkAxe(ownerPage, "owner correction accessibility");
    const editorBounds = await edit.boundingBox();
    assert.ok(
      editorBounds && editorBounds.x >= 0 && editorBounds.x + editorBounds.width <= 390,
      "mobile correction editor fits viewport",
    );
    await ownerPage.screenshot({
      path: join(options.artifactDirectory, "0102-correction-mobile.png"),
      fullPage: true,
    });
    await edit.getByRole("button", { name: "Lagre endringer", exact: true }).click();
    await expect(ownedRow).toContainText("Corrected same claim 0102");
    await approverPage.goto(`${dashboardOrigin}/dashboard/utlegg?status=Pending`);
    await expect(approvalRow).toContainText("Corrected same claim 0102");
    await approvalRow.getByRole("button", { name: "Avvis", exact: true }).click();
    await checkAxe(approverPage, "approval accessibility");
    const acceptedBefore = options.accepted();
    await approverPage.getByRole("button", { name: "Bekreft avvisning", exact: true }).click();
    await expect(
      approverPage.locator('[role="status"][data-action-intent="reject"]'),
    ).toContainText("avvist");
    assert.equal(options.accepted(), acceptedBefore + 1);
    await ownerPage.reload();
    await expect(ownedRow.locator('[data-status="Rejected"]')).toBeVisible();
    await expect(ownedRow.getByRole("button", { name: "Rediger", exact: true })).toHaveCount(0);
    await approverPage.setViewportSize({ width: 1440, height: 1000 });
    await approverPage.goto(`${dashboardOrigin}/dashboard/utlegg?status=Rejected`);
    await expect(approvalRow).toContainText("Corrected same claim 0102");
    await checkAxe(approverPage, "approval accessibility");
    await approverPage.screenshot({
      path: join(options.artifactDirectory, "0102-rejected-desktop.png"),
      fullPage: true,
    });
    const final = await snapshot(browserTarget.id);
    assert.equal(final.receipt.receipt_id, browserTarget.id);
    assert.equal(final.receipt.amount_ore, "600");
    assert.equal(final.receipt.revision, 4);
    assert.deepEqual(
      final.audit.map((r: any) => r.action),
      [
        "ReceiptSubmitted",
        "ReceiptRejected",
        "RejectedReceiptReopened",
        "PendingReceiptRevised",
        "ReceiptRejected",
      ],
    );
    assert.ok(final.outbox.every((r: any) => r.status === "Delivered"));
    assert.deepEqual(errors, []);
    return {
      specId: "0102",
      browser: true,
      mobileKeyboard: true,
      axe: "zero violations in reopen and correction views",
      sameIdentityContentOnReopen: true,
      noReopenEffects: true,
      finalAcknowledgedRejection: true,
      authorityAndTerminalDenials: true,
      exactReplayAndRevokedReplay: true,
      concurrentSingleWinner: concurrentStatuses,
      persistenceFailureRollbackRetry: true,
      auditActions: final.audit.map((r: any) => r.action),
      scope: "synthetic loopback; transport acknowledgement, no human delivery or payment claim",
    };
  } finally {
    if (browser) await browser.close();
    if (dashboard.exitCode === null && dashboard.signalCode === null) {
      const exited = new Promise((resolve) => dashboard.once("exit", resolve));
      dashboard.kill("SIGTERM");
      const timer = setTimeout(() => dashboard.kill("SIGKILL"), 5000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
