import {
  ReceiptAuxiliaryEffects,
  ReceiptFileService,
  ReceiptOutboxDeliveryResult,
  ReceiptPersistenceError,
  receiptOutboxRequest,
} from "@vektorprogrammet/domain/receipt";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "@effect/vitest";
import type { ReceiptApiConfig } from "./config.js";
import type { ReceiptFileStore } from "./filesystem.js";
import { drainReceiptOutboxWith, type ReceiptOutboxDrainOperations } from "./outbox-drain.js";

type Attempt = "Delivered" | "Idle" | "Failed" | "TransportFailure";

const receiptId = "receipt-drain";

const persistenceFailure = new ReceiptPersistenceError({
  operation: "drain fixture",
  message: "unavailable",
});

const claim = (attempt: number) => ({
  effectId: `effect-${attempt}`,
  commandId: "command-drain",
  ordinal: attempt,
  attempts: 1,
  claimId: "claim-drain",
  request: receiptOutboxRequest("command-drain", receiptId, "NotifyReceiptApproved"),
});

const fileService = { stage: () => Effect.void, apply: () => Effect.void };

const fileStore: ReceiptFileStore = {
  service: fileService,
  layer: Layer.succeed(ReceiptFileService, fileService),
  readCommitted: () => Effect.die("unexpected file read"),
  stageBytes: () => Effect.die("unexpected staging"),
  cleanupStage: () => Effect.void,
};

const config: ReceiptApiConfig = {
  stagingRoot: "/unused/staging",
  committedRoot: "/unused/committed",
  maxFileBytes: 1,
  now: () => "2026-09-25T12:00:00.000Z",
  nextReceiptId: () => receiptId,
  nextVisualId: () => "visual-drain",
};

const drain = (
  script: (attempt: number) => Attempt,
  stale: Pick<ReceiptOutboxDrainOperations, "listStaleOutboxClaims" | "recoverStaleOutboxClaim"> = {
    listStaleOutboxClaims: () => Effect.succeed([]),
    recoverStaleOutboxClaim: () => Effect.succeed(0),
  },
) => {
  let deliveries = 0;

  const economy: ReceiptOutboxDrainOperations = {
    ...stale,
    deliverNextOutboxEffect: () =>
      Effect.suspend((): Effect.Effect<ReceiptOutboxDeliveryResult, ReceiptPersistenceError> => {
        deliveries += 1;

        switch (script(deliveries)) {
          case "Delivered":
            return Effect.succeed(
              ReceiptOutboxDeliveryResult.Delivered({ claim: claim(deliveries) }),
            );
          case "Idle":
            return Effect.succeed(ReceiptOutboxDeliveryResult.Idle());
          case "Failed":
            return Effect.succeed(
              ReceiptOutboxDeliveryResult.Failed({
                claim: claim(deliveries),
                failureTag: "ProviderRejected",
              }),
            );
          case "TransportFailure":
            return Effect.fail(persistenceFailure);
        }
      }),
  };

  return drainReceiptOutboxWith(economy, { config }, fileStore, receiptId).pipe(
    Effect.provideService(ReceiptAuxiliaryEffects, { apply: () => Effect.void }),
    Effect.map((outcome) => ({ outcome, deliveries })),
  );
};

describe("receipt request outbox drain", () => {
  it.effect(
    "bounds one drain to 256 deliveries and stops at the first idle or failed delivery",
    () =>
      Effect.gen(function* () {
        expect(yield* drain(() => "Delivered")).toEqual({ outcome: "Limit", deliveries: 256 });

        expect(yield* drain((attempt) => (attempt === 256 ? "Idle" : "Delivered"))).toEqual({
          outcome: "Idle",
          deliveries: 256,
        });

        expect(yield* drain((attempt) => (attempt === 255 ? "Failed" : "Delivered"))).toEqual({
          outcome: "Failed",
          deliveries: 255,
        });

        expect(yield* drain(() => "Idle")).toEqual({ outcome: "Idle", deliveries: 1 });

        expect(
          yield* drain((attempt) => (attempt === 2 ? "TransportFailure" : "Delivered")),
        ).toEqual({ outcome: "Failed", deliveries: 2 });
      }),
  );

  it.effect("recovers every stale claim despite recovery failures before delivering", () =>
    Effect.gen(function* () {
      const recovered: Array<string> = [];

      const result = yield* drain(() => "Idle", {
        listStaleOutboxClaims: () => Effect.succeed(["stale-a", "stale-b"]),
        recoverStaleOutboxClaim: (staleClaimId) =>
          staleClaimId === "stale-a"
            ? Effect.fail(persistenceFailure)
            : Effect.sync(() => {
                recovered.push(staleClaimId);

                return 1;
              }),
      });

      const unlisted = yield* drain(() => "Idle", {
        listStaleOutboxClaims: () => Effect.fail(persistenceFailure),
        recoverStaleOutboxClaim: () => Effect.die("no stale claims were listed"),
      });

      expect(recovered).toEqual(["stale-b"]);
      expect(result).toEqual({ outcome: "Idle", deliveries: 1 });
      expect(unlisted).toEqual({ outcome: "Idle", deliveries: 1 });
    }),
  );
});
