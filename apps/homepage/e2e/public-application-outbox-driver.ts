import { DatabaseLive } from "@vektorprogrammet/database";
import {
  claimNextPublicApplicationOutbox,
  deliverNextPublicApplicationOutbox,
  failPublicApplicationOutbox,
  makeRecordingPublicApplicationEffectInterpreter,
} from "@vektorprogrammet/domain/application";
import { Effect, Redacted } from "effect";

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
  const firstClaim = yield* claimNextPublicApplicationOutbox(
    "public-application-injected-failure",
    claimedAt,
  );
  if (firstClaim === undefined) {
    return yield* failProof("Public-application outbox was empty");
  }

  interpreter.failOnce(firstClaim.effectId);
  const injected = yield* Effect.exit(interpreter.deliver(firstClaim.request, firstClaim.ordinal));
  if (injected._tag !== "Failure") {
    return yield* failProof("Recording interpreter did not inject the requested failure");
  }
  yield* failPublicApplicationOutbox(firstClaim, "InjectedRecordingFailure");

  const retry = yield* deliverNextPublicApplicationOutbox(
    "public-application-retry",
    "2031-09-15T12:00:02.000Z",
    interpreter,
  );
  if (retry._tag !== "Delivered" || retry.claim.effectId !== firstClaim.effectId) {
    return yield* failProof("Public-application outbox did not retry the failed effect first");
  }

  let deliveryIndex = 0;
  while (true) {
    const result = yield* deliverNextPublicApplicationOutbox(
      `public-application-delivery-${deliveryIndex}`,
      `2031-09-15T12:00:${String(deliveryIndex + 3).padStart(2, "0")}.000Z`,
      interpreter,
    );
    if (result._tag === "Idle") break;
    if (result._tag !== "Delivered") {
      return yield* failProof("Public-application outbox returned an unexpected delivery state");
    }
    deliveryIndex += 1;
    if (deliveryIndex > 32) {
      return yield* failProof("Public-application outbox did not reach its bounded idle state");
    }
  }

  const snapshot = interpreter.snapshot();
  const appliedEffectIds = snapshot.map((entry) => entry.effectId);
  return {
    retriedEffectId: firstClaim.effectId,
    injectedFailureTag: "InjectedRecordingFailure",
    appliedEffectIds,
    duplicateProviderApplyCount: appliedEffectIds.length - new Set(appliedEffectIds).size,
    effects: snapshot,
  };
});

try {
  const evidence = await Effect.runPromise(
    Effect.scoped(program.pipe(Effect.provide(databaseLayer))),
  );
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch {
  process.stderr.write("Public-application recording outbox driver failed\n");
  process.exitCode = 1;
}
