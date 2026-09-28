/** 0102: extends the owned 0095/0097 runtime, sharing their local acknowledged transport. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { Pool } from "pg";
import { Config, Data, Effect, Match, Option, Path, Predicate, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";
import { loopbackPortFree } from "@monoweb/postgres";
import { ReceiptId } from "@vektorprogrammet/rpc";
import { StrongETag, IdempotencyKey } from "@vektorprogrammet/rpc/problem";
import { nativeScriptClient, type ScriptCallResult } from "@vektorprogrammet/rpc/script";
import { jsonText, step } from "../acceptance/journey-step.js";

type ReceiptAction = "approve" | "reject" | "reopen" | "withdraw";

/** A gate of the reopening observation that failed, with what it observed. */
class ReceiptReopenObservationFailed extends Data.TaggedError("ReceiptReopenObservationFailed")<{
  readonly message: string;
}> {}

/** The resource of a successful receipt command; any other answer fails the observation. */
const resourceOf = <A>(result: ScriptCallResult<A>, label: string): A => {
  assert.ok(result.ok, `${label} answered ${result.status}`);

  return result.value;
};

/** The options of the reopening observation, from the 0097 delivery observation. */
export interface ReceiptReopeningOptions {
  readonly pool: Pool;
  readonly origin: string;
  readonly dashboardOrigin: string;
  readonly cookie: string;
  readonly approverCookie: string;
  readonly root: string;
  readonly artifactDirectory: string;
  readonly attempts: () => number;
  readonly accepted: () => number;
  readonly setDeliveryAvailable: (available: boolean) => void;
}

/** Observes the reopening of rejected receipts through the API and the production dashboard. */
export const observeReceiptReopening = (options: ReceiptReopeningOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { pool, origin, dashboardOrigin, cookie, approverCookie } = options;
      const path = yield* Path.Path;

      const native = yield* Effect.acquireRelease(
        Effect.sync(() => nativeScriptClient(origin)),
        (client) => Effect.promise(() => client.dispose()),
      );

      const as = (session: string) => ({ cookie: session, origin: dashboardOrigin });

      const query = (text: string, values?: ReadonlyArray<unknown>) =>
        step(() => pool.query(text, values === undefined ? undefined : [...values]));

      /** One receipt transition, as the session given, answered with its registry status. */
      const request = (
        id: string,
        action: ReceiptAction,
        etag: string,
        session = approverCookie,
        key: string = randomUUID(),
      ) =>
        step(() =>
          native.call(as(session), (client) => {
            const payload = {
              receiptId: ReceiptId.make(id),
              idempotencyKey: IdempotencyKey.make(key),
              ifMatch: StrongETag.make(etag),
            };

            return Match.value(action).pipe(
              Match.when("approve", () => client["receipts.approveReceipt"](payload)),
              Match.when("reject", () => client["receipts.rejectReceipt"](payload)),
              Match.when("reopen", () => client["receipts.reopenReceipt"](payload)),
              Match.when("withdraw", () => client["receipts.withdrawReceipt"](payload)),
              Match.exhaustive,
            );
          }),
        );

      const row = (id: string) =>
        query("SELECT * FROM economy_receipts WHERE receipt_id=$1", [id]).pipe(
          Effect.map((result) => result.rows[0]),
        );

      const snapshot = Effect.fnUntraced(function* (id: string) {
        return {
          receipt: yield* row(id),
          audit: (yield* query(
            "SELECT * FROM economy_receipt_audit WHERE receipt_id=$1 ORDER BY receipt_revision",
            [id],
          )).rows,
          commands: (yield* query(
            "SELECT * FROM economy_receipt_command_receipts WHERE receipt_id=$1 ORDER BY command_id",
            [id],
          )).rows,
          outbox: (yield* query(
            "SELECT * FROM economy_receipt_outbox WHERE receipt_id=$1 ORDER BY effect_id",
            [id],
          )).rows,
        };
      });

      const submit = Effect.fnUntraced(function* () {
        const resource = resourceOf(
          yield* step(() =>
            native.call(as(cookie), (client) =>
              client["receipts.submitReceipt"]({
                idempotencyKey: IdempotencyKey.make(randomUUID()),
                departmentId: "receipt-department-0095",
                request: {
                  description: "Synthetic correction 0102",
                  amountOre: 500,
                  receiptDate: "2026-09-06",
                  file: {
                    contentType: "application/pdf",
                    bytes: new TextEncoder().encode("%PDF-1.4\nSynthetic 0102\n%%EOF"),
                  },
                },
              }),
            ),
          ),
          "synthetic submission",
        );

        return { id: resource.receiptId, etag: resource.etag };
      });

      const rejected = Effect.fnUntraced(function* () {
        const receipt = yield* submit();

        const response = resourceOf(
          yield* request(receipt.id, "reject", receipt.etag),
          "rejection",
        );

        return { ...receipt, initialEtag: receipt.etag, etag: response.etag };
      });

      options.setDeliveryAvailable(false);
      const target = yield* rejected();
      options.setDeliveryAvailable(true);
      const before = yield* snapshot(target.id);
      assert.ok(before.outbox.some((item: any) => item.status === "Failed"));
      const attemptsBefore = options.attempts();

      // Invalid commands must have no persisted footprint. The payload schema requires If-Match and
      // has no member for authority, so a missing revision or an extra authority cannot be sent.
      for (const [name, response, expected] of [
        ["owner", yield* request(target.id, "reopen", target.etag, cookie), 403],
        ["stale revision", yield* request(target.id, "reopen", target.initialEtag), 412],
      ] as const)
        assert.equal(response.status, expected, name);
      assert.deepEqual(yield* snapshot(target.id), before);

      for (const mutation of [
        "UPDATE economy_receipt_approval_grants SET end_at=date_trunc('milliseconds',now(),'UTC'),revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
        "UPDATE organization_memberships SET end_at=date_trunc('milliseconds',now(),'UTC') WHERE membership_id='receipt0097-approver-membership'",
      ]) {
        yield* query(mutation);
        assert.equal((yield* request(target.id, "reopen", target.etag)).status, 403);
        yield* query(
          "UPDATE economy_receipt_approval_grants SET end_at=NULL,revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
        );
        yield* query(
          "UPDATE organization_memberships SET end_at=NULL WHERE membership_id='receipt0097-approver-membership'",
        );
      }

      yield* query(
        "INSERT INTO organization_departments(department_id,name,short_name,email,city,active) VALUES ('receipt-wrong-0102','Wrong0102','Wrong0102','wrong0102@example.invalid','Synthetic',true)",
      );
      yield* query(
        "UPDATE economy_receipt_approval_grants SET department_id='receipt-wrong-0102',revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
      );
      assert.equal((yield* request(target.id, "reopen", target.etag)).status, 403);
      yield* query(
        "UPDATE economy_receipt_approval_grants SET department_id='receipt-department-0095',revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
      );
      // Real database failure after mutation but before commit must roll the entire command back.
      yield* query(
        "CREATE FUNCTION fail_reopen_0102() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='RejectedReceiptReopened' THEN RAISE EXCEPTION 'synthetic0102'; END IF; RETURN NEW; END $$",
      );
      yield* query(
        "CREATE TRIGGER fail_reopen_0102 BEFORE INSERT ON economy_receipt_audit FOR EACH ROW EXECUTE FUNCTION fail_reopen_0102()",
      );
      const retryKey = IdempotencyKey.make(randomUUID());
      assert.equal(
        (yield* request(target.id, "reopen", target.etag, approverCookie, retryKey)).status,
        503,
      );
      assert.deepEqual(yield* snapshot(target.id), before);
      yield* query("DROP TRIGGER fail_reopen_0102 ON economy_receipt_audit");
      yield* query("DROP FUNCTION fail_reopen_0102()");

      const reopened = resourceOf(
        yield* request(target.id, "reopen", target.etag, approverCookie, retryKey),
        "reopening",
      );

      assert.equal(reopened.status, "Pending");
      const after = yield* snapshot(target.id);
      assert.deepEqual(after.receipt, {
        ...before.receipt,
        status: "Pending",
        revision: before.receipt.revision + 1,
      });
      assert.equal(after.audit.length, before.audit.length + 1);
      assert.equal(after.commands.length, before.commands.length + 1);
      assert.deepEqual(after.outbox, before.outbox);
      assert.equal(options.attempts(), attemptsBefore);

      const replay = resourceOf(
        yield* request(target.id, "reopen", target.etag, approverCookie, retryKey),
        "reopening replay",
      );

      assert.deepEqual(replay, reopened);
      assert.deepEqual(yield* snapshot(target.id), after);
      assert.equal(
        (yield* request(target.id, "reopen", reopened.etag, approverCookie, retryKey)).status,
        409,
      );
      yield* query(
        "UPDATE economy_receipt_approval_grants SET end_at=date_trunc('milliseconds',now(),'UTC'),revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
      );
      assert.equal(
        (yield* request(target.id, "reopen", target.etag, approverCookie, retryKey)).status,
        403,
      );
      yield* query(
        "UPDATE economy_receipt_approval_grants SET end_at=NULL,revision=revision+1 WHERE approval_grant_id='receipt0097-approve'",
      );
      assert.equal((yield* request(target.id, "reopen", reopened.etag)).status, 409);
      const race = yield* rejected();

      const results = yield* Effect.all(
        [request(race.id, "reopen", race.etag), request(race.id, "reopen", race.etag)],
        { concurrency: "unbounded" },
      );

      const concurrentStatuses = results.map((r) => r.status).sort((a, b) => a - b);
      assert.equal(concurrentStatuses.filter((status) => status === 200).length, 1);
      assert.ok(
        concurrentStatuses
          .filter((status) => status !== 200)
          .every((status) => status === 412 || status === 503),
      );
      assert.equal(
        Number(
          (yield* query(
            "SELECT count(*) FROM economy_receipt_audit WHERE receipt_id=$1 AND action='RejectedReceiptReopened'",
            [race.id],
          )).rows[0].count,
        ),
        1,
      );
      assert.equal((yield* request(race.id, "approve", race.etag)).status, 412);

      for (const action of ["approve", "withdraw"] as const) {
        const receipt = yield* submit();

        const closed = yield* request(
          receipt.id,
          action,
          receipt.etag,
          action === "withdraw" ? cookie : approverCookie,
        );

        const closedEtag = resourceOf(closed, `${action} of a pending receipt`).etag;
        const closedBefore = yield* snapshot(receipt.id);
        assert.equal((yield* request(receipt.id, "reopen", closedEtag)).status, 409);
        assert.deepEqual(yield* snapshot(receipt.id), closedBefore);
      }

      // Browser journey uses real sessions from this driver's native sign-in and the built dashboard.
      const browserTarget = yield* rejected();
      const browserBefore = yield* snapshot(browserTarget.id);

      const requireDashboard = createRequire(
        path.join(options.root, "apps/dashboard/package.json"),
      );

      const { chromium, expect } = requireDashboard("@playwright/test");
      const { default: AxeBuilder } = requireDashboard("@axe-core/playwright");

      const checkAxe = Effect.fnUntraced(function* (page: any, gate: string) {
        yield* step(() =>
          page.evaluate(
            "Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))",
          ),
        );

        const violations = (yield* step(() => new AxeBuilder({ page }).analyze())).violations.map(
          (v: any) => ({
            id: v.id,
            nodes: v.nodes.map((node: any) => ({
              target: node.target,
              summary: node.failureSummary,
            })),
          }),
        );

        if (violations.length > 0) {
          yield* step(() =>
            page.screenshot({
              path: path.join(options.artifactDirectory, "0102-browser-failure.png"),
              fullPage: true,
            }),
          );

          return yield* new ReceiptReopenObservationFailed({
            message: yield* jsonText({ gate, violations }),
          });
        }
      });

      // The production dashboard binds the reserved port of this rehearsal; it must still be free.
      const dashboardPort = new URL(dashboardOrigin).port;

      assert.ok(
        yield* step(() => loopbackPortFree(Number(dashboardPort))),
        `dashboard port ${dashboardPort} is free`,
      );

      const dashboardRoot = path.join(options.root, "apps/dashboard");

      const environment = {
        API_URL: origin,
        VITE_API_URL: dashboardOrigin,
        DASHBOARD_ORIGIN: dashboardOrigin,
        DASHBOARD_MOUNT: "/",
        HOST: "127.0.0.1",
        PORT: dashboardPort,
        NODE_ENV: "production",
      };

      const startupDiagnostics: string[] = [];

      const captureDiagnostics = (chunk: string) => {
        startupDiagnostics.push(chunk);

        if (startupDiagnostics.length > 20) startupDiagnostics.shift();
      };

      // The build and the server run in this scope, which stops each process group, SIGTERM first
      // and SIGKILL after five seconds.
      const owned = (args: ReadonlyArray<string>) =>
        ChildProcess.make("bun", args, {
          cwd: dashboardRoot,
          env: environment,
          extendEnv: true,
          stdin: "ignore",
          stdout: "ignore",
          forceKillAfter: "5 seconds",
        });

      const build = yield* owned(["run", "build"]);

      const [, buildCode] = yield* Effect.all(
        [
          build.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((text) => Effect.sync(() => captureDiagnostics(text))),
          ),
          build.exitCode,
        ],
        { concurrency: "unbounded" },
      );

      if (buildCode !== 0)
        return yield* new ReceiptReopenObservationFailed({
          message: `Production proof build failed in ${dashboardRoot}: exit=${buildCode}; ${startupDiagnostics.join("").slice(-4000)}`,
        });

      const dashboard = yield* owned(["server.mjs"]);

      yield* dashboard.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((text) => Effect.sync(() => captureDiagnostics(text))),
        Effect.ignore,
        Effect.forkScoped,
      );

      const client = yield* HttpClient.HttpClient;

      const loginAnswers = client.get(`${dashboardOrigin}/login`).pipe(
        Effect.map((response) => response.status === 200),
        Effect.orElseSucceed(() => false),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      );

      let ready = false;

      for (let n = 0; n < 100; n++) {
        if (!(yield* dashboard.isRunning)) break;

        if (yield* loginAnswers) {
          ready = true;
          break;
        }

        yield* Effect.sleep("100 millis");
      }

      const dashboardExit = (yield* dashboard.isRunning)
        ? "null"
        : String(yield* dashboard.exitCode.pipe(Effect.orElseSucceed(() => "null")));

      assert.ok(
        ready,
        `production dashboard startup: exit=${dashboardExit}; ${startupDiagnostics.join("").slice(-4000)}`,
      );

      const executablePath = Option.getOrElse(
        yield* Config.option(Config.String("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH")),
        () => "/etc/profiles/per-user/nori/bin/chromium-browser",
      );

      const browser = yield* Effect.acquireRelease(
        step(() => chromium.launch({ executablePath, headless: true })),
        (launched: any) => Effect.promise(() => launched.close()),
      );

      const errors: string[] = [];
      const mutations: Array<{ path: string; status: number }> = [];

      const context = Effect.fnUntraced(function* (session: string) {
        const value = yield* step(() =>
          browser.newContext({ viewport: { width: 390, height: 844 } }),
        );

        const equals = session.indexOf("=");
        yield* step(() =>
          value.addCookies([
            {
              name: session.slice(0, equals),
              value: session.slice(equals + 1),
              url: dashboardOrigin,
              httpOnly: true,
              sameSite: "Lax",
            },
          ]),
        );
        const page = yield* step(() => value.newPage());
        page.on("response", (response: any) => {
          if (response.request().method() === "POST")
            mutations.push({ path: new URL(response.url()).pathname, status: response.status() });
        });
        page.on("pageerror", () => errors.push("browser runtime error"));
        page.on("console", (message: any) => {
          if (message.type() === "error") {
            const location = message.location();

            const path =
              Predicate.isString(location.url) && location.url.length > 0
                ? new URL(location.url).pathname
                : "unknown";

            const text = message.text();
            errors.push(
              JSON.stringify({
                kind: "browser console error",
                path,
                // Project common network diagnostics without arbitrary browser text or URLs.
                networkStatus: text.match(/server responded with a status of (\d+)/)?.[1] ?? null,
                hydration: /hydrat/i.test(text),
              }),
            );
          }
        });

        return page;
      });

      const ownerPage = yield* context(cookie),
        approverPage = yield* context(approverCookie);

      const ownedRow = ownerPage.locator(`tr[data-receipt-id="${browserTarget.id}"]`);
      yield* step(() => ownerPage.goto(`${dashboardOrigin}/dashboard/mine-utlegg`));
      yield* step(() => expect(ownedRow.locator('[data-status="Rejected"]')).toBeVisible());
      yield* step(() =>
        expect(ownedRow.getByRole("button", { name: "Rediger", exact: true })).toHaveCount(0),
      );
      yield* step(() => approverPage.goto(`${dashboardOrigin}/dashboard/utlegg?status=Rejected`));
      const approvalRow = approverPage.locator(`tr[data-receipt-id="${browserTarget.id}"]`);
      yield* step(() => expect(approvalRow).toBeVisible());
      const button = approvalRow.getByRole("button", { name: "Åpne for korrigering", exact: true });
      yield* step(() => button.focus());
      yield* step(() => approverPage.keyboard.press("Enter"));
      yield* step(() => expect(approverPage.getByRole("alertdialog")).toBeVisible());
      yield* checkAxe(approverPage, "approval accessibility");
      yield* step(() =>
        approverPage.screenshot({
          path: path.join(options.artifactDirectory, "0102-reopen-mobile.png"),
          fullPage: true,
        }),
      );
      const browserAttempts = options.attempts();
      yield* step(() =>
        approverPage.getByRole("button", { name: "Bekreft gjenåpning", exact: true }).click(),
      );

      yield* step(() =>
        expect(approverPage.locator('[role="status"][data-action-intent="reopen"]')).toContainText(
          "åpnet for korrigering",
        ),
      ).pipe(
        Effect.catch(() =>
          Effect.gen(function* () {
            yield* step(() =>
              approverPage.screenshot({
                path: path.join(options.artifactDirectory, "0102-browser-failure.png"),
                fullPage: true,
              }),
            );

            return yield* new ReceiptReopenObservationFailed({
              message: yield* jsonText({
                gate: "browser reopen confirmation",
                mutations,
                alerts: yield* step(() => approverPage.locator('[role="alert"]').allTextContents()),
                path: new URL(approverPage.url()).pathname,
                sqlState: (yield* row(browserTarget.id)).status,
                browserErrors: errors,
              }),
            });
          }),
        ),
      );

      yield* step(() => expect(approvalRow).toHaveCount(0));
      assert.equal(options.attempts(), browserAttempts);
      const browserReopened = yield* snapshot(browserTarget.id);
      assert.deepEqual(browserReopened.receipt, {
        ...browserBefore.receipt,
        status: "Pending",
        revision: 2,
      });
      assert.deepEqual(browserReopened.outbox, browserBefore.outbox);
      yield* step(() => ownerPage.reload());
      yield* step(() => ownedRow.getByRole("button", { name: "Rediger", exact: true }).click());

      const edit = ownerPage
        .locator('[data-receipt-form="revise"]')
        .filter({ has: ownerPage.locator(`input[name="receiptId"][value="${browserTarget.id}"]`) });

      yield* step(() => edit.locator('[name="description"]').fill("Corrected same claim 0102"));
      yield* step(() => edit.locator('[name="amountNok"]').fill("6,00"));
      yield* checkAxe(ownerPage, "owner correction accessibility");
      const editorBounds = yield* step(() => edit.boundingBox());
      assert.ok(
        editorBounds !== null &&
          editorBounds !== undefined &&
          editorBounds.x >= 0 &&
          editorBounds.x + editorBounds.width <= 390,
        "mobile correction editor fits viewport",
      );
      yield* step(() =>
        ownerPage.screenshot({
          path: path.join(options.artifactDirectory, "0102-correction-mobile.png"),
          fullPage: true,
        }),
      );
      yield* step(() => edit.getByRole("button", { name: "Lagre endringer", exact: true }).click());
      yield* step(() => expect(ownedRow).toContainText("Corrected same claim 0102"));
      yield* step(() => approverPage.goto(`${dashboardOrigin}/dashboard/utlegg?status=Pending`));
      yield* step(() => expect(approvalRow).toContainText("Corrected same claim 0102"));
      yield* step(() => approvalRow.getByRole("button", { name: "Avvis", exact: true }).click());
      yield* checkAxe(approverPage, "approval accessibility");
      yield* step(() =>
        approverPage.getByRole("button", { name: "Bekreft avvisning", exact: true }).hover(),
      );
      yield* checkAxe(approverPage, "destructive hover accessibility");
      const acceptedBefore = options.accepted();
      yield* step(() =>
        approverPage.getByRole("button", { name: "Bekreft avvisning", exact: true }).click(),
      );
      yield* step(() =>
        expect(approverPage.locator('[role="status"][data-action-intent="reject"]')).toContainText(
          "avvist",
        ),
      );
      assert.equal(options.accepted(), acceptedBefore + 1);
      yield* step(() => ownerPage.reload());
      yield* step(() => expect(ownedRow.locator('[data-status="Rejected"]')).toBeVisible());
      yield* step(() =>
        expect(ownedRow.getByRole("button", { name: "Rediger", exact: true })).toHaveCount(0),
      );
      yield* step(() => approverPage.setViewportSize({ width: 1440, height: 1000 }));
      yield* step(() => approverPage.goto(`${dashboardOrigin}/dashboard/utlegg?status=Rejected`));
      yield* step(() => expect(approvalRow).toContainText("Corrected same claim 0102"));
      yield* checkAxe(approverPage, "approval accessibility");
      yield* step(() =>
        approverPage.screenshot({
          path: path.join(options.artifactDirectory, "0102-rejected-desktop.png"),
          fullPage: true,
        }),
      );
      const final = yield* snapshot(browserTarget.id);
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
    }),
  );
