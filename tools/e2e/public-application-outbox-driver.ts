import { Database } from "@vektorprogrammet/database";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { deliverNextPublicApplicationOutbox } from "@vektorprogrammet/database/application";
import { makeRecordingPublicApplicationEffectInterpreter } from "@vektorprogrammet/domain/application";
import { Predicate, Effect, Redacted } from "effect";

const postgresUrl = process.env.PUBLIC_APPLICATION_OUTBOX_PG_URL;

if (!postgresUrl) {
  throw new Error("Missing PUBLIC_APPLICATION_OUTBOX_PG_URL");
}

const claimedAt = "2031-09-15T12:00:01.000Z";

const interpreter = makeRecordingPublicApplicationEffectInterpreter();

const databaseLayer = DatabaseLive({
  url: Redacted.make(postgresUrl),
  applicationName: "public-application-recording-outbox-0039",
  maxConnections: 2,
});

const failProof = (message: string): Effect.Effect<never> =>
  Effect.sync(() => {
    throw new Error(message);
  });

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
  const delivered = [];

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

try {
  const evidence = await Effect.runPromise(
    Effect.scoped(program.pipe(Effect.provide(databaseLayer))),
  );

  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (error) {
  process.stderr.write(
    `Public-application recording outbox driver failed: ${error instanceof Error ? error.message : "unknown failure"}\n`,
  );
  process.exitCode = 1;
}
