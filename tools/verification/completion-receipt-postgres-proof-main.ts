import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { deliverJson } from "@vektorprogrammet/backend/delivery/http";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { Database } from "@vektorprogrammet/database";
import { NotificationGateway } from "@vektorprogrammet/domain/notification";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import {
  RecruitmentNotificationDeliveryError,
  RecruitmentNotificationEvidenceSchema,
} from "@vektorprogrammet/domain/recruitment";
import {
  claimNextRecruitmentInterviewCompletion,
  deliverNextRecruitmentInterviewCompletion,
  releaseRecruitmentInterviewCompletion,
} from "@vektorprogrammet/database/recruitment";
import { Schema, Predicate, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { DatabaseLive } from "@vektorprogrammet/database/live";

interface CapturedRequest {
  readonly idempotencyKey: string;
  readonly body: unknown;
  readonly status: number;
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of request) chunks.push(Buffer.from(chunk));

  return Buffer.concat(chunks).toString("utf8");
};

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || Predicate.isString(address)) {
        reject(new Error("loopback receiver did not expose a TCP port"));

        return;
      }

      resolve(address.port);
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

const main = async (): Promise<void> => {
  const pgUrl = process.env.COMPLETION_RECEIPT_PG_URL;

  if (pgUrl === undefined || pgUrl.trim() === "")
    throw new Error("COMPLETION_RECEIPT_PG_URL is required");

  const captured: CapturedRequest[] = [];
  let rejectNext = true;
  const token = "completion-receipt-0108-loopback-token";

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (
      request.method !== "POST" ||
      request.url !== "/effects" ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      response.statusCode = 404;
      response.end();

      return;
    }

    const body = Schema.decodeSync(Schema.fromJsonString(Schema.Json))(await readBody(request));

    const status = rejectNext ? 503 : 204;
    rejectNext = false;
    captured.push({
      idempotencyKey: Predicate.isString(request.headers["idempotency-key"])
        ? request.headers["idempotency-key"]
        : "",
      body,
      status,
    });
    response.statusCode = status;
    response.end();
  });

  const port = await listen(server);

  try {
    const databaseLayer = DatabaseLive({
      url: Redacted.make(pgUrl),
      applicationName: "interview-completion-receipt-0108",
      maxConnections: 1,
    });

    const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));
    const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));

    const profileLayer = ProfileLive.pipe(
      Layer.provide(Layer.merge(databaseLayer, organizationLayer)),
    );

    const authorityLayers = Layer.mergeAll(
      databaseLayer,
      admissionsLayer,
      organizationLayer,
      profileLayer,
    );

    const transport = {
      endpoint: new URL(`http://127.0.0.1:${port}/effects`),
      token,
      deliveryTimeoutMilliseconds: 2_000,
    };

    const gateway = Layer.succeed(
      NotificationGateway,
      NotificationGateway.of({
        deliverInterviewCompletionReceipt: (request) =>
          deliverJson(request, transport, {
            "idempotency-key": request.effectId,
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.map(() =>
              RecruitmentNotificationEvidenceSchema.make({
                effectId: request.effectId,
                deliveredAt: "2026-09-20T12:10:00.000Z",
                providerReference: `loopback:${request.effectId}`,
              }),
            ),
            Effect.mapError(
              () =>
                new RecruitmentNotificationDeliveryError({
                  effectId: request.effectId,
                  message: "loopback interview completion receipt delivery unavailable",
                }),
            ),
          ),
        deliverInterviewInvitation: (request) =>
          Effect.fail(
            new RecruitmentNotificationDeliveryError({
              effectId: request.effectId,
              message: "invitation delivery is outside completion receipt proof",
            }),
          ),
        deliverInterviewInvitationResponse: (request) =>
          Effect.fail(
            new RecruitmentNotificationDeliveryError({
              effectId: request.effectId,
              message: "invitation response delivery is outside completion receipt proof",
            }),
          ),
      }),
    );

    const program = Effect.gen(function* () {
      const database = yield* Database;

      const winningClaim = yield* claimNextRecruitmentInterviewCompletion(
        "completion-0108-winning-claim",
        "2026-09-20T12:07:00.000Z",
      );

      if (winningClaim === undefined)
        return yield* Effect.die(new Error("completion concurrency proof found no winning claim"));

      const losingClaim = yield* claimNextRecruitmentInterviewCompletion(
        "completion-0108-losing-claim",
        "2026-09-20T12:07:00.000Z",
      );

      yield* releaseRecruitmentInterviewCompletion(winningClaim);

      const first = yield* deliverNextRecruitmentInterviewCompletion(
        "completion-0108-failed-claim",
        "2026-09-20T12:08:00.000Z",
      );

      const [afterFailure] = yield* database<{
        readonly status: string;
        readonly attempts: number;
        readonly payloadRetained: boolean;
        readonly envelope: unknown;
      }>`
        SELECT status, attempts, payload_json <> '{}'::jsonb AS "payloadRetained",
          delivery_envelope AS envelope
        FROM public.recruitment_interview_completion_outbox
      `;

      const second = yield* deliverNextRecruitmentInterviewCompletion(
        "completion-0108-retry-claim",
        "2026-09-20T12:09:00.000Z",
      );

      yield* database`
        INSERT INTO public.recruitment_interview_completion_outbox (
          effect_id, effect_type, command_id, interview_id, application_id,
          interview_revision, payload_json
        )
        SELECT 'tampered-completion-0108', 'SendInterviewCompletionReceipt',
          receipt.command_id, receipt.interview_id, interview.application_id,
          receipt.resulting_revision, '{"unexpected":true}'::jsonb
        FROM public.recruitment_interview_lifecycle_command_receipts AS receipt
        INNER JOIN public.recruitment_interviews AS interview
          ON interview.interview_id = receipt.interview_id
        WHERE receipt.kind = 'InterviewCancelled'
        ORDER BY receipt.committed_at ASC
        LIMIT 1
      `;

      const quarantined = yield* deliverNextRecruitmentInterviewCompletion(
        "completion-0108-quarantine-claim",
        "2026-09-20T12:11:00.000Z",
      );

      const [afterQuarantine] = yield* database<{
        readonly status: string;
        readonly failureTag: string | null;
      }>`
        SELECT status, last_failure_tag AS "failureTag"
        FROM public.recruitment_interview_completion_outbox
        WHERE effect_id = 'tampered-completion-0108'
      `;

      const idle = yield* deliverNextRecruitmentInterviewCompletion(
        "completion-0108-idle-claim",
        "2026-09-20T12:12:00.000Z",
      );

      const [afterSuccess] = yield* database<{
        readonly effectId: string;
        readonly status: string;
        readonly attempts: number;
        readonly payloadCleared: boolean;
        readonly envelope: unknown;
        readonly providerReference: string | null;
        readonly deliveredAt: string | null;
      }>`
        SELECT effect_id AS "effectId", status, attempts,
          payload_json = '{}'::jsonb AS "payloadCleared", delivery_envelope AS envelope,
          provider_reference AS "providerReference",
          to_char(delivered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deliveredAt"
        FROM public.recruitment_interview_completion_outbox
        WHERE status = 'Delivered'
      `;

      return {
        winningClaim,
        losingClaim,
        first,
        afterFailure,
        second,
        quarantined,
        afterQuarantine,
        idle,
        afterSuccess,
      };
    }).pipe(Effect.provide([gateway, authorityLayers]), Effect.scoped);

    const observed = await Effect.runPromise(program);

    if (
      observed.winningClaim.claimId !== "completion-0108-winning-claim" ||
      observed.losingClaim !== undefined ||
      !Predicate.isTagged(observed.first, "Failed") ||
      observed.afterFailure?.status !== "Failed" ||
      observed.afterFailure.attempts !== 2 ||
      observed.afterFailure.payloadRetained !== true ||
      !Predicate.isTagged(observed.second, "Delivered") ||
      !Predicate.isTagged(observed.quarantined, "Idle") ||
      observed.afterQuarantine?.status !== "Quarantined" ||
      observed.afterQuarantine.failureTag !== "AuthorityEnvelopeMismatch" ||
      !Predicate.isTagged(observed.idle, "Idle") ||
      observed.afterSuccess?.status !== "Delivered" ||
      observed.afterSuccess.attempts !== 3 ||
      observed.afterSuccess.payloadCleared !== true ||
      observed.afterSuccess.providerReference !== `loopback:${observed.afterSuccess.effectId}` ||
      captured.length !== 2 ||
      captured[0]?.idempotencyKey !== observed.afterSuccess.effectId ||
      captured[1]?.idempotencyKey !== observed.afterSuccess.effectId ||
      JSON.stringify(captured[0]?.body) !== JSON.stringify(captured[1]?.body) ||
      JSON.stringify(observed.afterFailure.envelope) !==
        JSON.stringify(observed.afterSuccess.envelope)
    )
      throw new Error(`completion receipt proof failed: ${JSON.stringify({ observed, captured })}`);
    const body = captured[0]?.body;

    if (body === null || !(body === null || Predicate.isObjectOrArray(body)))
      throw new Error("completion body is not an object");
    const keys = Object.keys(body).sort();

    const expectedKeys = [
      "_tag",
      "applicantDisplayName",
      "applicantEmail",
      "applicationId",
      "commandId",
      "effectId",
      "interviewId",
      "interviewRevision",
      "interviewerDisplayName",
      "interviewerEmail",
    ].sort();

    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys))
      throw new Error(`completion envelope fields changed: ${JSON.stringify(keys)}`);
    process.stdout.write(`${JSON.stringify({ result: "Passed", observed, captured }, null, 2)}\n`);
  } finally {
    await close(server);
  }
};

await main();
