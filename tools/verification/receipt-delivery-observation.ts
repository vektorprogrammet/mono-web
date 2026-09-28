/** 0097 extends the owned 0095 PostgreSQL/API rehearsal after its zero-effect import window. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { Config, Data, type Duration, Effect, Option, Predicate, Schema } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";
import { ReceiptId } from "@vektorprogrammet/rpc";
import { IdempotencyKey, StrongETag } from "@vektorprogrammet/rpc/problem";
import { nativeScriptClient } from "@vektorprogrammet/rpc/script";
import { observeReceiptReopening } from "./receipt-reopen-observation.js";
import { jsonText, step } from "../acceptance/journey-step.js";
import type { Pool } from "pg";

/** A bounded operator drain that outlived its deadline. */
class ReceiptDrainTimeout extends Data.TaggedError("ReceiptDrainTimeout")<{
  readonly message: string;
}> {}

/** The envelope fields that the observation reads; the sink keeps every field of the body. */
const DeliveryEnvelope = Schema.Struct({
  deliveryId: Schema.String,
  from: Schema.String,
  to: Schema.String,
  subject: Schema.String,
  text: Schema.String,
});

const decodeEnvelope = Schema.decodeEffect(Schema.fromJsonString(DeliveryEnvelope));

const decodeBody = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const drainDeadline: Duration.Input = "30 seconds";

/** The options of the delivery observation, from the 0095 rehearsal that owns the runtime. */
export interface ReceiptDeliveryOptions<E, R> {
  readonly pool: Pool;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly origin: string;
  readonly dashboardOrigin: string;
  readonly cookie: string;
  readonly approverCookie: string;
  readonly root: string;
  readonly artifactDirectory: string;
  readonly registerSecret: (secret: string) => void;
  /** Restarts the owned backend with the environment given, once it answers its health check. */
  readonly restart: (
    env: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<void, E, R>;
}

/**
 * Observes acknowledged receipt delivery through a loopback sink on the `HttpServer` that the
 * entry provides, operator drains, and approvals, then the 0102 reopening when it is enabled.
 */
export const observeReceiptDelivery = <E, R>(options: ReceiptDeliveryOptions<E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { pool, origin, dashboardOrigin, cookie, approverCookie } = options;
      const token = randomBytes(24).toString("hex");
      options.registerSecret(token);
      let mode: "accept" | "reject" | "ambiguous" | "redirect" = "accept";

      const attempts: Array<typeof DeliveryEnvelope.Type & Readonly<Record<string, Schema.Json>>> =
        [];

      const accepted = new Map<string, string>();
      let redirected = 0;

      // A request that breaks a sink assertion answers 500; the observation fails on it at the end.
      const sinkFailures: string[] = [];

      const receive = Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;

        if (req.url === "/uncontrolled") {
          redirected++;

          return HttpServerResponse.empty({ status: 500 });
        }

        if (req.url !== "/accept" || req.headers["authorization"] !== `Bearer ${token}`)
          return HttpServerResponse.empty({ status: 401 });

        const raw = Buffer.from(yield* req.arrayBuffer).toString();
        const envelope = yield* decodeEnvelope(raw);
        const body = { ...(yield* decodeBody(raw)), ...envelope };
        assert.equal(req.headers["idempotency-key"], body.deliveryId);
        assert.ok(!/ciphertext|paymentAccount|objectKey|fileRef|synthetic:/.test(raw));
        attempts.push(body);

        if (mode === "redirect")
          return HttpServerResponse.empty({ status: 307, headers: { location: "/uncontrolled" } });

        if (mode === "reject") return HttpServerResponse.empty({ status: 503 });

        if (accepted.has(body.deliveryId) && accepted.get(body.deliveryId) !== raw)
          return HttpServerResponse.empty({ status: 409 });

        accepted.set(body.deliveryId, raw);

        // Accepted remotely; intentionally withhold acknowledgement until the backend gives up.
        if (mode === "ambiguous") return yield* Effect.never;

        return HttpServerResponse.empty({ status: 202 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            sinkFailures.push(String(cause));

            return HttpServerResponse.empty({ status: 500 });
          }),
        ),
      );

      yield* HttpServer.serveEffect(receive);

      const { address } = yield* HttpServer.HttpServer;

      if (Predicate.isTagged(address, "UnixPathAddress"))
        assert.fail("loopback sink binds a TCP port");

      const port = address.port;

      const env = {
        ...options.env,
        RECEIPT_DELIVERY_URL: `http://127.0.0.1:${port}/accept`,
        RECEIPT_DELIVERY_TOKEN: token,
        RECEIPT_DELIVERY_TIMEOUT_MS: "100",
        RECEIPT_DELIVERY_SENDER: "economy0097@example.invalid",
        RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: yield* jsonText({
          "receipt-department-0095": "finance0097@example.invalid",
        }),
      };

      /** The exit code of one bounded operator drain; an exit on a signal counts as 1. */
      const operatorDrain = (
        receiptId: string,
        selectedEnv: Readonly<Record<string, string | undefined>> = env,
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* ChildProcess.make(
              "bun",
              ["run", "apps/backend/src/receipt/drain-main.ts", receiptId],
              {
                cwd: options.root,
                env: { ...selectedEnv },
                extendEnv: true,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
              },
            );

            return yield* child.exitCode.pipe(Effect.orElseSucceed(() => 1));
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: drainDeadline,
            orElse: () =>
              Effect.fail(new ReceiptDrainTimeout({ message: "bounded drain timeout" })),
          }),
        );

      const query = (text: string, values?: ReadonlyArray<unknown>) =>
        step(() => pool.query(text, values === undefined ? undefined : [...values]));

      const outbox = (id: string) =>
        query(
          "SELECT effect_id,status,attempts,delivery_envelope,payload_json FROM economy_receipt_outbox WHERE receipt_id=$1 ORDER BY ordinal",
          [id],
        ).pipe(Effect.map((result) => result.rows));

      const keys = new Map<string, string>();

      const identity = (key: string) => {
        if (!keys.has(key)) keys.set(key, randomUUID());

        return keys.get(key)!;
      };

      const native = yield* Effect.acquireRelease(
        Effect.sync(() => nativeScriptClient(origin)),
        (client) => Effect.promise(() => client.dispose()),
      );

      const as = (session: string) => ({ cookie: session, origin: dashboardOrigin });

      /** One approval or rejection, as the session given, answered with its registry status. */
      const transition = (
        action: "approve" | "reject",
        session: string,
        key: string,
        receipt: { readonly id: string; readonly etag: string },
      ) =>
        step(() =>
          native.call(as(session), (client) => {
            const payload = {
              receiptId: ReceiptId.make(receipt.id),
              idempotencyKey: IdempotencyKey.make(identity(key)),
              ifMatch: StrongETag.make(receipt.etag),
            };

            return action === "approve"
              ? client["receipts.approveReceipt"](payload)
              : client["receipts.rejectReceipt"](payload);
          }),
        );

      const submit = Effect.fnUntraced(function* (key: string) {
        const result = yield* step(() =>
          native.call(as(cookie), (client) =>
            client["receipts.submitReceipt"]({
              idempotencyKey: IdempotencyKey.make(identity(key)),
              departmentId: "receipt-department-0095",
              request: {
                description: "Synthetic acknowledged delivery",
                amountOre: 500,
                receiptDate: "2026-09-06",
                file: {
                  contentType: "application/pdf",
                  bytes: new TextEncoder().encode("%PDF-1.4\nSynthetic 0097\n%%EOF"),
                },
              },
            }),
          ),
        );

        assert.ok(result.ok, `synthetic submission answered ${result.status}`);
        assert.ok(result.value.receiptId.length > 0);

        return { id: result.value.receiptId, etag: result.value.etag };
      });

      yield* query(
        "INSERT INTO person_contact_profiles(person_id,email,phone) VALUES ('receipt-owner-0095','owner0095@example.invalid','90000000'),('receipt-foreign-0095','foreign0095@example.invalid','90000001')",
      );
      yield* query(
        "INSERT INTO organization_teams(team_id,department_id,name) VALUES ('receipt0097-team','receipt-department-0095','Synthetic economy team')",
      );
      yield* query(
        "INSERT INTO organization_memberships(membership_id,person_id,team_id,start_at,end_at,position_id,is_team_leader) VALUES ('receipt0097-owner-membership','receipt-owner-0095','receipt0097-team','2026-01-01',NULL,NULL,FALSE),('receipt0097-approver-membership','receipt-foreign-0095','receipt0097-team','2026-01-01',NULL,NULL,FALSE)",
      );
      yield* query(
        `INSERT INTO economy_payment_authorities(payment_authority_id,person_id,department_id,payment_account_ciphertext,start_at,revision) VALUES ('receipt0097-submit','receipt-owner-0095','receipt-department-0095','synthetic:0097','2026-01-01',0)`,
      );
      yield* query(
        `INSERT INTO economy_receipt_approval_grants(approval_grant_id,person_id,scope,department_id,start_at,revision) VALUES ('receipt0097-approve','receipt-foreign-0095','Department','receipt-department-0095','2026-01-01',0)`,
      );
      // First observe the unconfigured composition: successful business write cannot fake delivery.
      const missing = yield* submit("receipt0097-missing");
      assert.ok((yield* outbox(missing.id)).some((r) => r.status === "Failed"));
      assert.equal(attempts.length, 0);
      yield* options.restart(env);
      assert.equal(yield* operatorDrain("nonexistent-0097"), 1);
      assert.equal(yield* operatorDrain(missing.id, { ...env, RECEIPT_COMMITTED_ROOT: "" }), 1);
      assert.equal(yield* operatorDrain(missing.id), 0);
      assert.ok((yield* outbox(missing.id)).every((r) => r.status === "Delivered"));
      assert.equal(attempts[0]!.to, "finance0097@example.invalid");

      const commandCount = Number(
        (yield* query("SELECT count(*) FROM economy_receipt_command_receipts WHERE receipt_id=$1", [
          missing.id,
        ])).rows[0].count,
      );

      assert.equal(commandCount, 1);
      mode = "reject";
      const failed = yield* submit("receipt0097-rejection");
      assert.ok((yield* outbox(failed.id)).some((r) => r.status === "Failed"));
      const first = attempts.at(-1)!;

      const changedEnv = {
        ...env,
        RECEIPT_DELIVERY_ECONOMY_RECIPIENTS: yield* jsonText({
          "receipt-department-0095": "changed@example.invalid",
        }),
      };

      mode = "accept";
      yield* options.restart(changedEnv);
      assert.equal(yield* operatorDrain(failed.id, changedEnv), 0);
      assert.deepEqual(attempts.at(-1), first);
      yield* step(() =>
        assert.rejects(
          pool.query(
            "UPDATE economy_receipt_outbox SET delivery_envelope=NULL WHERE effect_id=$1",
            [first.deliveryId],
          ),
        ),
      );
      // Approval uses owner contact, then freezes it across ambiguous acceptance and restart.
      mode = "ambiguous";

      const approval = yield* transition("approve", approverCookie, "receipt0097-approve", failed);

      assert.equal(approval.status, 200, yield* jsonText(approval));
      assert.ok((yield* outbox(failed.id)).some((r) => r.status === "Failed"));
      const approvalEnvelope = attempts.at(-1)!;
      assert.equal(approvalEnvelope.to, "owner0095@example.invalid");
      assert.equal(
        (yield* outbox(failed.id)).find((row) => row.effect_id === approvalEnvelope.deliveryId)
          ?.payload_json._tag,
        "NotifyReceiptApproved",
      );
      assert.match(approvalEnvelope.text, /5.00 NOK/);
      assert.match(approvalEnvelope.text, /Synthetic acknowledged delivery/);
      assert.match(approvalEnvelope.text, /2026-09-06/);
      yield* query(
        "UPDATE person_contact_profiles SET email='changed-owner@example.invalid' WHERE person_id='receipt-owner-0095'",
      );
      mode = "accept";
      yield* options.restart(env);
      assert.equal(yield* operatorDrain(failed.id), 0);
      assert.deepEqual(attempts.at(-1), approvalEnvelope);
      assert.equal(
        [...accepted.keys()].filter((id) => id === approvalEnvelope.deliveryId).length,
        1,
      );
      // Concurrent bounded drains converge without repeating the underlying receipt mutation.
      mode = "reject";
      const concurrent = yield* submit("receipt0097-concurrent");
      yield* query(
        "UPDATE economy_receipt_outbox SET status='Processing',claim_id='crashed0097',claimed_at=date_trunc('milliseconds',now(),'UTC')-interval '2 minutes' WHERE receipt_id=$1 AND status='Failed'",
        [concurrent.id],
      );
      mode = "accept";

      const concurrentResults = yield* Effect.all(
        [operatorDrain(concurrent.id), operatorDrain(concurrent.id)],
        { concurrency: "unbounded" },
      );

      assert.ok(concurrentResults.some((code) => code === 0));
      assert.ok((yield* outbox(concurrent.id)).every((r) => r.status === "Delivered"));
      mode = "redirect";

      const rejected = yield* transition(
        "reject",
        approverCookie,
        "receipt0097-reject",
        concurrent,
      );

      assert.equal(rejected.status, 200, yield* jsonText(rejected));
      assert.ok((yield* outbox(concurrent.id)).some((r) => r.status === "Failed"));
      assert.equal(redirected, 0);
      mode = "accept";
      assert.equal(
        yield* operatorDrain(concurrent.id, { ...env, RECEIPT_DELIVERY_TOKEN: "wrong" }),
        1,
      );
      assert.equal(yield* operatorDrain(concurrent.id), 0);
      assert.equal(attempts.at(-1)!.to, "changed-owner@example.invalid");
      assert.match(attempts.at(-1)!.subject, /avvist/);
      assert.match(attempts.at(-1)!.text, /Kontakt økonomiansvarlig/);

      const reopening = Option.contains(
        yield* Config.option(Config.String("RECEIPT_REOPEN_REHEARSAL")),
        "1",
      )
        ? yield* observeReceiptReopening({
            pool,
            origin,
            dashboardOrigin,
            cookie,
            approverCookie,
            root: options.root,
            artifactDirectory: options.artifactDirectory,
            attempts: () => attempts.length,
            accepted: () => accepted.size,
            setDeliveryAvailable: (available) => {
              mode = available ? "accept" : "reject";
            },
          })
        : undefined;

      const countBefore = Number(
        (yield* query("SELECT count(*) FROM economy_receipt_command_receipts")).rows[0].count,
      );

      yield* query(
        "UPDATE economy_receipt_approval_grants SET end_at=date_trunc('milliseconds',now(),'UTC'),revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
      );

      const denied = yield* transition("reject", approverCookie, "receipt0097-denied", missing);

      assert.equal(denied.status, 403);
      assert.equal(
        Number(
          (yield* query("SELECT count(*) FROM economy_receipt_command_receipts")).rows[0].count,
        ),
        countBefore,
      );
      const audit = (yield* query("SELECT count(*) FROM economy_receipt_audit")).rows[0].count;
      assert.equal(Number(audit), countBefore);

      assert.deepEqual(sinkFailures, [], "every sink request met its assertions");

      return {
        specId: "0097",
        reopening,
        transportAttempts: attempts.length,
        distinctAccepted: accepted.size,
        submissionEconomyRecipient: true,
        approvalOwnerRecipient: true,
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
    }),
  );
