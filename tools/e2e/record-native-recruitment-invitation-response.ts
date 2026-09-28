import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import {
  deliverNextRecruitmentInvitationResponse,
  invitationResponsePayloadForEvidence,
} from "@vektorprogrammet/database/recruitment";
import { makeRecordingNotificationGateway } from "@vektorprogrammet/domain/notification";
import { RecruitmentInvitationResponseOutboxRequestSchema } from "@vektorprogrammet/domain/recruitment";
import { Config, Console, Data, Effect, Layer, Predicate, Schema } from "effect";

class RecordingFailure extends Data.TaggedError("RecordingFailure")<{
  readonly message: string;
}> {}

// The JSON text of the evidence, byte for byte what `JSON.stringify` writes, as `jsonText` of the
// backend's RPC problem module does.
const jsonText = <A>(value: A): Effect.Effect<string> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie);

const fail = (message: string): Effect.Effect<never, RecordingFailure> =>
  Effect.fail(new RecordingFailure({ message }));

const databaseUrl = Config.schema(Schema.Redacted(Schema.NonEmptyString), "BACKEND_PG_URL").pipe(
  Effect.mapError(
    () =>
      new RecordingFailure({
        message: "BACKEND_PG_URL is required for response recording evidence",
      }),
  ),
);

const deliveredAt = "2031-09-15T12:01:00.000Z";

const recording = makeRecordingNotificationGateway(deliveredAt);

const databaseLayer = Layer.unwrap(
  Effect.map(databaseUrl, (url) =>
    DatabaseLive({
      url,
      applicationName: "native-invitation-response-recording-evidence",
      maxConnections: 1,
    }),
  ),
);

const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));

const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));

const profileLayer = ProfileLive.pipe(Layer.provide(Layer.merge(databaseLayer, organizationLayer)));

const authorityLayers = Layer.mergeAll(
  databaseLayer,
  admissionsLayer,
  organizationLayer,
  profileLayer,
);

// The recording gateway must not reach the network: the trap counts and rejects every attempt
// while the deliveries run, and restores the platform fetch when the scope closes.
const networkTrap = Effect.acquireRelease(
  Effect.sync(() => {
    const originalFetch = globalThis.fetch;
    const trap = { originalFetch, providerNetworkRequests: 0 };

    globalThis.fetch = Object.assign(
      (..._arguments: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
        trap.providerNetworkRequests += 1;

        return Promise.reject(
          new Error("The recording NotificationGateway attempted network access"),
        );
      },
      {
        preconnect: () => {
          trap.providerNetworkRequests += 1;
          throw new Error("The recording NotificationGateway attempted network access");
        },
      },
    );

    return trap;
  }),
  (trap) =>
    Effect.sync(() => {
      globalThis.fetch = trap.originalFetch;
    }),
);

const deliverOnce = (index: number) =>
  Effect.gen(function* () {
    const result = yield* Effect.scoped(
      deliverNextRecruitmentInvitationResponse(
        "native-invitation-response-recording-claim-" + String(index + 1),
        "2031-09-15T12:00:0" + String(index + 1) + ".000Z",
      ).pipe(Effect.provide(Layer.mergeAll(recording.layer, authorityLayers))),
    );

    if (!Predicate.isTagged(result, "Delivered")) {
      return yield* fail("Expected a recorded invitation-response delivery");
    }

    return {
      result: result._tag,
      claim: {
        effectId: result.claim.effectId,
        claimId: result.claim.claimId,
        attempts: result.claim.attempts,
      },
      notificationEvidence: result.evidence,
    };
  });

const program = Effect.gen(function* () {
  const trap = yield* networkTrap;

  const results = yield* Effect.forEach([0, 1], deliverOnce);

  if (recording.responseRequests.length !== 2) {
    return yield* fail("Expected exactly two approved response requests");
  }

  if (trap.providerNetworkRequests !== 0) {
    return yield* fail("The recording NotificationGateway performed network access");
  }

  const responseRequests = yield* Effect.forEach(recording.responseRequests, (request) =>
    Schema.decodeEffect(Schema.fromJsonString(RecruitmentInvitationResponseOutboxRequestSchema))(
      invitationResponsePayloadForEvidence(request),
    ),
  );

  const evidenceText = yield* jsonText({
    results,
    responseRequests,
    providerNetworkRequests: trap.providerNetworkRequests,
  });

  yield* Console.log(evidenceText);
});

BunRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(BunServices.layer)));
