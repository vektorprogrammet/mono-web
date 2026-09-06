/** 0097 extends the owned 0095 PostgreSQL/API rehearsal after its zero-effect import window. */
import assert from "node:assert/strict";
import { observeReceiptReopening } from "./receipt-reopen-observation.js";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";

export const observeReceiptDelivery = async (options: {
  pool: Pool;
  env: NodeJS.ProcessEnv;
  origin: string;
  cookie: string;
  approverCookie: string;
  root: string;
  restart: (env: NodeJS.ProcessEnv) => Promise<void>;
}) => {
  const { pool, origin, cookie, approverCookie } = options;
  const token = randomBytes(24).toString("hex");
  let mode: "accept" | "reject" | "ambiguous" | "redirect" = "accept";
  const attempts: Array<{
    deliveryId: string;
    from: string;
    to: string;
    subject: string;
    text: string;
  }> = [];
  const accepted = new Map<string, string>();
  let redirected = 0;
  const sink = createServer(async (req, res) => {
    if (req.url === "/uncontrolled") {
      redirected++;
      res.writeHead(500).end();
      return;
    }
    if (req.url !== "/accept" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = JSON.parse(raw);
    assert.equal(req.headers["idempotency-key"], body.deliveryId);
    assert.ok(!/ciphertext|paymentAccount|objectKey|fileRef|synthetic:/.test(raw));
    attempts.push(body);
    if (mode === "redirect") {
      res.writeHead(307, { location: "/uncontrolled" }).end();
      return;
    }
    if (mode === "reject") {
      res.writeHead(503).end();
      return;
    }
    if (accepted.has(body.deliveryId) && accepted.get(body.deliveryId) !== raw) {
      res.writeHead(409).end();
      return;
    }
    accepted.set(body.deliveryId, raw);
    if (mode === "ambiguous") return; // accepted remotely; intentionally withhold acknowledgement
    res.writeHead(202).end();
  });
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
  const port = (sink.address() as { port: number }).port;
  const env = {
    ...options.env,
    RECEIPT_DELIVERY_URL: `http://127.0.0.1:${port}/accept`,
    RECEIPT_DELIVERY_TOKEN: token,
    RECEIPT_DELIVERY_TIMEOUT_MS: "100",
    RECEIPT_DELIVERY_SENDER: "economy0097@example.invalid",
    RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: JSON.stringify({
      "receipt-department-0095": "finance0097@example.invalid",
    }),
  };
  const operatorDrain = (
    receiptId: string,
    selectedEnv: Readonly<Record<string, string | undefined>> = env,
  ) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn("bun", ["run", "apps/backend/src/receipt/drain-main.ts", receiptId], {
        cwd: options.root,
        env: selectedEnv,
        stdio: "ignore",
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("bounded drain timeout"));
      }, 30_000);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });
  const outbox = async (id: string) =>
    (
      await pool.query(
        "SELECT effect_id,status,attempts,delivery_envelope FROM economy_receipt_outbox WHERE receipt_id=$1 ORDER BY ordinal",
        [id],
      )
    ).rows;
  const keys = new Map<string, string>();
  const identity = (key: string) => {
    if (!keys.has(key)) keys.set(key, randomUUID());
    return keys.get(key)!;
  };
  const headers = (session: string, key: string, etag?: string) => ({
    cookie: session,
    origin: "http://127.0.0.1:5174",
    "idempotency-key": identity(key),
    ...(etag ? { "if-match": etag, "content-type": "application/json" } : {}),
  });
  const submit = async (key: string) => {
    const form = new FormData();
    form.set("description", "Synthetic acknowledged delivery");
    form.set("amountOre", "500");
    form.set("receiptDate", "2026-09-06");
    form.set(
      "file",
      new File(["%PDF-1.4\nSynthetic 0097\n%%EOF"], "receipt.pdf", { type: "application/pdf" }),
    );
    const response = await fetch(`${origin}/api/receipts?departmentId=receipt-department-0095`, {
      method: "POST",
      headers: headers(cookie, key),
      body: form,
    });
    assert.equal(response.status, 201, await response.clone().text());
    const body = (await response.json()) as { receiptId: string };
    assert.ok(body.receiptId);
    return { id: body.receiptId, etag: response.headers.get("etag")! };
  };
  try {
    await pool.query(
      "INSERT INTO person_contact_profiles(person_id,email,phone) VALUES ('receipt-owner-0095','owner0095@example.invalid','90000000'),('receipt-foreign-0095','foreign0095@example.invalid','90000001')",
    );
    await pool.query(
      "INSERT INTO organization_teams(team_id,department_id,name) VALUES ('receipt0097-team','receipt-department-0095','Synthetic economy team')",
    );
    await pool.query(
      "INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,end_at,position_id,is_team_leader) VALUES ('receipt0097-owner-membership','receipt-owner-0095','receipt0097-team','2026-01-01',NULL,NULL,FALSE),('receipt0097-approver-membership','receipt-foreign-0095','receipt0097-team','2026-01-01',NULL,NULL,FALSE)",
    );
    await pool.query(
      `INSERT INTO economy_payment_authorities(payment_authority_id,person_id,department_id,payment_account_ciphertext,start_at,revision) VALUES ('receipt0097-submit','receipt-owner-0095','receipt-department-0095','synthetic:0097','2026-01-01',0)`,
    );
    await pool.query(
      `INSERT INTO economy_receipt_approval_grants(approval_grant_id,person_id,scope,department_id,start_at,revision) VALUES ('receipt0097-approve','receipt-foreign-0095','Department','receipt-department-0095','2026-01-01',0)`,
    );
    // First observe the unconfigured composition: successful business write cannot fake delivery.
    const missing = await submit("receipt0097-missing");
    assert.ok((await outbox(missing.id)).some((r) => r.status === "Failed"));
    assert.equal(attempts.length, 0);
    await options.restart(env);
    assert.equal(await operatorDrain("nonexistent-0097"), 1);
    assert.equal(await operatorDrain(missing.id, { ...env, RECEIPT_COMMITTED_ROOT: "" }), 1);
    assert.equal(await operatorDrain(missing.id), 0);
    assert.ok((await outbox(missing.id)).every((r) => r.status === "Delivered"));
    assert.equal(attempts[0]!.to, "finance0097@example.invalid");
    const commandCount = Number(
      (
        await pool.query(
          "SELECT count(*) FROM economy_receipt_command_receipts WHERE receipt_id=$1",
          [missing.id],
        )
      ).rows[0].count,
    );
    assert.equal(commandCount, 1);
    mode = "reject";
    const failed = await submit("receipt0097-rejection");
    assert.ok((await outbox(failed.id)).some((r) => r.status === "Failed"));
    const first = attempts.at(-1)!;
    const changedEnv = {
      ...env,
      RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: JSON.stringify({
        "receipt-department-0095": "changed@example.invalid",
      }),
    };
    mode = "accept";
    await options.restart(changedEnv);
    assert.equal(await operatorDrain(failed.id, changedEnv), 0);
    assert.deepEqual(attempts.at(-1), first);
    await assert.rejects(
      pool.query("UPDATE economy_receipt_outbox SET delivery_envelope=NULL WHERE effect_id=$1", [
        first.deliveryId,
      ]),
    );
    // Refund uses owner contact, then freezes it across ambiguous acceptance and restart.
    mode = "ambiguous";
    const refund = await fetch(`${origin}/api/receipts/${failed.id}:refund`, {
      method: "POST",
      headers: headers(approverCookie, "receipt0097-refund", failed.etag),
      body: "{}",
    });
    assert.equal(refund.status, 200, await refund.clone().text());
    assert.ok((await outbox(failed.id)).some((r) => r.status === "Failed"));
    const refundEnvelope = attempts.at(-1)!;
    assert.equal(refundEnvelope.to, "owner0095@example.invalid");
    assert.match(refundEnvelope.subject, /markert som refundert/);
    assert.match(refundEnvelope.text, /5.00 NOK/);
    assert.match(refundEnvelope.text, /Synthetic acknowledged delivery/);
    assert.match(refundEnvelope.text, /2026-09-06/);
    await pool.query(
      "UPDATE person_contact_profiles SET email='changed-owner@example.invalid' WHERE person_id='receipt-owner-0095'",
    );
    mode = "accept";
    await options.restart(env);
    assert.equal(await operatorDrain(failed.id), 0);
    assert.deepEqual(attempts.at(-1), refundEnvelope);
    assert.equal([...accepted.keys()].filter((id) => id === refundEnvelope.deliveryId).length, 1);
    // Concurrent bounded drains converge without repeating the underlying receipt mutation.
    mode = "reject";
    const concurrent = await submit("receipt0097-concurrent");
    await pool.query(
      "UPDATE economy_receipt_outbox SET status='Processing',claim_id='crashed0097',claimed_at=now()-interval '2 minutes' WHERE receipt_id=$1 AND status='Failed'",
      [concurrent.id],
    );
    mode = "accept";
    const concurrentResults = await Promise.all([
      operatorDrain(concurrent.id),
      operatorDrain(concurrent.id),
    ]);
    assert.ok(concurrentResults.some((code) => code === 0));
    assert.ok((await outbox(concurrent.id)).every((r) => r.status === "Delivered"));
    mode = "redirect";
    const rejected = await fetch(`${origin}/api/receipts/${concurrent.id}:reject`, {
      method: "POST",
      headers: headers(approverCookie, "receipt0097-reject", concurrent.etag),
      body: "{}",
    });
    assert.equal(rejected.status, 200, await rejected.clone().text());
    assert.ok((await outbox(concurrent.id)).some((r) => r.status === "Failed"));
    assert.equal(redirected, 0);
    mode = "accept";
    assert.equal(
      await operatorDrain(concurrent.id, { ...env, RECEIPT_DELIVERY_TOKEN: "wrong" }),
      1,
    );
    assert.equal(await operatorDrain(concurrent.id), 0);
    assert.equal(attempts.at(-1)!.to, "changed-owner@example.invalid");
    assert.match(attempts.at(-1)!.subject, /avvist/);
    assert.match(attempts.at(-1)!.text, /Kontakt økonomiansvarlig/);
    const reopening =
      process.env.RECEIPT_REOPEN_REHEARSAL === "1"
        ? await observeReceiptReopening({
            pool,
            origin,
            cookie,
            approverCookie,
            root: options.root,
            attempts: () => attempts.length,
            accepted: () => accepted.size,
            setDeliveryAvailable: (available) => {
              mode = available ? "accept" : "reject";
            },
          })
        : undefined;
    const countBefore = Number(
      (await pool.query("SELECT count(*) FROM economy_receipt_command_receipts")).rows[0].count,
    );
    await pool.query(
      "UPDATE economy_receipt_approval_grants SET end_at=now(),revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
    );
    const denied = await fetch(`${origin}/api/receipts/${missing.id}:reject`, {
      method: "POST",
      headers: headers(approverCookie, "receipt0097-denied", missing.etag),
      body: "{}",
    });
    assert.equal(denied.status, 403);
    assert.equal(
      Number(
        (await pool.query("SELECT count(*) FROM economy_receipt_command_receipts")).rows[0].count,
      ),
      countBefore,
    );
    const audit = (await pool.query("SELECT count(*) FROM economy_receipt_audit")).rows[0].count;
    assert.equal(Number(audit), countBefore);
    return {
      specId: "0097",
      reopening,
      transportAttempts: attempts.length,
      distinctAccepted: accepted.size,
      submissionEconomyRecipient: true,
      refundOwnerRecipient: true,
      rejectionOwnerRecipient: true,
      missingConfigurationPending: true,
      forcedRejectionRetry: true,
      ambiguousAcceptanceStableRetryAfterRestart: true,
      immutableEnvelope: true,
      staleCrashClaimRecovered: true,
      concurrentDrains: concurrentResults,
      redirectDestinationsReached: redirected,
      invalidTokenRejected: true,
      revokedApprovalDenied: denied.status,
      businessCommands: countBefore,
      sqlAuditFacts: Number(audit),
      historicalImportWindowAttempts: 0,
      scope:
        "local synthetic; 2xx means transport acceptance, not human receipt; receiver deduplication required; at-least-once retry",
    };
  } finally {
    sink.closeAllConnections();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
  }
};
