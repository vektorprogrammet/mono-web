import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Database } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { deliverNextPublicApplicationOutbox } from "@vektorprogrammet/database/application";
import { makeRecordingPublicApplicationEffectInterpreter } from "@vektorprogrammet/domain/application";
import { Cause, Config, Console, Data, Effect, Layer, Predicate, Schema } from "effect";

class OutboxDriverFailure extends Data.TaggedError("OutboxDriverFailure")<{
  readonly message: string;
}> {}

// The JSON text of the evidence, byte for byte what `JSON.stringify` writes, as `jsonText` of the
// backend's RPC problem module does.
const jsonText = <A>(value: A): Effect.Effect<string> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie);

const postgresUrl = Config.schema(
  Schema.Redacted(Schema.NonEmptyString),
  "PUBLIC_APPLICATION_OUTBOX_PG_URL",
).pipe(
  Effect.mapError(
    () => new OutboxDriverFailure({ message: "Missing PUBLIC_APPLICATION_OUTBOX_PG_URL" }),
  ),
);

type DeliveryResult = Effect.Success<ReturnType<typeof deliverNextPublicApplicationOutbox>>;

const claimedAt = "2031-09-15T12:00:01.000Z";

const interpreter = makeRecordingPublicApplicationEffectInterpreter();

const databaseLayer = Layer.unwrap(
  Effect.map(postgresUrl, (url) =>
    DatabaseLive({
      url,
      applicationName: "public-application-recording-outbox-0039",
      maxConnections: 2,
    }),
  ),
);

const failProof = (message: string): Effect.Effect<never, OutboxDriverFailure> =>
  Effect.fail(new OutboxDriverFailure({ message }));

const program = Effect.gen(function* () {
  const rows = yield* Database.use(
    (database) =>
      database<{ readonly effect_id: string }>`
        SELECT outbox.effect_id
        FROM admission_application_outbox AS outbox
        INNER JOIN admission_application_command_receipts AS receipt
          ON receipt.command_id = outbox.command_id
        WHERE outbox.status IN ('Pending', 'Failed')
        ORDER BY receipt.committed_at, outbox.command_id, outbox.ordinal
        LIMIT 1
      `,
  );

  const firstEffectId = rows[0]?.effect_id;

  if (firstEffectId === undefined) {
    return yield* failProof("Public-application outbox was empty");
  }

  interpreter.failOnce(firstEffectId);

  const injected = yield* deliverNextPublicApplicationOutbox(
    "public-application-injected-failure",
    claimedAt,
    interpreter,
  );

  if (!Predicate.isTagged(injected, "Failed") || injected.claim.effectId !== firstEffectId) {
    return yield* failProof("Public-application outbox did not persist provider failure");
  }

  // The failed effect returns to the retry queue; the claim order serves other commands'
  // effects fairly before it, so the retry is found in the drain instead of the next claim.
  const delivered: Array<Extract<DeliveryResult, { readonly _tag: "Delivered" }>> = [];

  while (true) {
    const result = yield* deliverNextPublicApplicationOutbox(
      `public-application-delivery-${delivered.length}`,
      `2031-09-15T12:00:${String(delivered.length + 2).padStart(2, "0")}.000Z`,
      interpreter,
    );

    if (Predicate.isTagged(result, "Idle")) break;

    if (!Predicate.isTagged(result, "Delivered")) {
      return yield* failProof("Public-application outbox returned an unexpected delivery state");
    }

    delivered.push(result);

    if (delivered.length > 32) {
      return yield* failProof("Public-application outbox did not reach its bounded idle state");
    }
  }

  const retry = delivered.find((result) => result.claim.effectId === firstEffectId);

  if (retry === undefined) {
    return yield* failProof("Public-application outbox did not retry the failed effect");
  }

  yield* interpreter.deliver(retry.claim.request, retry.claim.ordinal, retry.claim.attempts + 1);

  const snapshot = interpreter.snapshot();
  const appliedEffectIds = snapshot.map((entry) => entry.effectId);

  return {
    retriedEffectId: firstEffectId,
    injectedFailureTag: injected.failureTag,
    appliedEffectIds,
    duplicateProviderApplyCount: appliedEffectIds.length - new Set(appliedEffectIds).size,
    duplicateProviderDeliveryCount: interpreter.duplicateDeliveryCount(),
    effects: snapshot,
  };
});

const main = Effect.scoped(program.pipe(Effect.provide(databaseLayer))).pipe(
  Effect.flatMap(jsonText),
  Effect.flatMap((evidenceText) => Console.log(evidenceText)),
  Effect.tapCause((cause) => {
    const error = Cause.squash(cause);

    return Console.error(
      `Public-application recording outbox driver failed: ${error instanceof Error ? error.message : "unknown failure"}`,
    );
  }),
  Effect.provide(BunServices.layer),
);

BunRuntime.runMain(main, { disableErrorReporting: true });
