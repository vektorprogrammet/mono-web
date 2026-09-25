import {
  ReceiptAuxiliaryEffects,
  ReceiptFileService,
  ReceiptOutboxDeliveryResult,
  ReceiptPersistenceError,
  receiptOutboxRequest,
} from "@vektorprogrammet/domain/receipt";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { runTestPromise } from "../../test/runtime.js";
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
  readCommitted: async () => {
    throw new Error("unexpected file read");
  },
  stageBytes: async () => {
    throw new Error("unexpected staging");
  },
  cleanupStage: async () => undefined,
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

  return runTestPromise(
    drainReceiptOutboxWith(economy, { config }, fileStore, receiptId).pipe(
      Effect.provideService(ReceiptAuxiliaryEffects, { apply: () => Effect.void }),
    ),
  ).then((outcome) => ({ outcome, deliveries }));
};

describe("receipt request outbox drain", () => {
  it("bounds one drain to 256 deliveries and stops at the first idle or failed delivery", async () => {
    await expect(drain(() => "Delivered")).resolves.toEqual({ outcome: "Limit", deliveries: 256 });
    await expect(drain((attempt) => (attempt === 256 ? "Idle" : "Delivered"))).resolves.toEqual({
      outcome: "Idle",
      deliveries: 256,
    });
    await expect(drain((attempt) => (attempt === 255 ? "Failed" : "Delivered"))).resolves.toEqual({
      outcome: "Failed",
      deliveries: 255,
    });
    await expect(drain(() => "Idle")).resolves.toEqual({ outcome: "Idle", deliveries: 1 });
    await expect(
      drain((attempt) => (attempt === 2 ? "TransportFailure" : "Delivered")),
    ).resolves.toEqual({ outcome: "Failed", deliveries: 2 });
  });

  it("recovers every stale claim despite recovery failures before delivering", async () => {
    const recovered: Array<string> = [];

    const result = await drain(() => "Idle", {
      listStaleOutboxClaims: () => Effect.succeed(["stale-a", "stale-b"]),
      recoverStaleOutboxClaim: (staleClaimId) =>
        staleClaimId === "stale-a"
          ? Effect.fail(persistenceFailure)
          : Effect.sync(() => {
              recovered.push(staleClaimId);

              return 1;
            }),
    });

    const unlisted = await drain(() => "Idle", {
      listStaleOutboxClaims: () => Effect.fail(persistenceFailure),
      recoverStaleOutboxClaim: () => Effect.die("no stale claims were listed"),
    });

    expect(recovered).toEqual(["stale-b"]);
    expect(result).toEqual({ outcome: "Idle", deliveries: 1 });
    expect(unlisted).toEqual({ outcome: "Idle", deliveries: 1 });
  });
});
