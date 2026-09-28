import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { DatabaseLive } from "@vektorprogrammet/database/live";
import { AdmissionsLive } from "@vektorprogrammet/database/admissions";
import { OrganizationLive } from "@vektorprogrammet/database/organization";
import { ProfileLive } from "@vektorprogrammet/database/profile";
import {
  deliverNextRecruitmentInvitation,
  invitationPayloadForEvidence,
} from "@vektorprogrammet/database/recruitment";
import { makeRecordingNotificationGateway } from "@vektorprogrammet/domain/notification";
import { RecruitmentInvitationOutboxRequestSchema } from "@vektorprogrammet/domain/recruitment";
import { Config, Console, Data, Effect, FileSystem, Layer, Path, Predicate, Schema } from "effect";

class RecordingFailure extends Data.TaggedError("RecordingFailure")<{
  readonly message: string;
}> {}

// The JSON text of the evidence, byte for byte what `JSON.stringify` writes, as `jsonText` of the
// backend's RPC problem module does.
const jsonText = <A>(value: A): Effect.Effect<string> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value).pipe(Effect.orDie);

const requiredEnvironment = <A>(schema: Schema.ConstraintCodec<A, unknown>, name: string) =>
  Config.schema(schema, name).pipe(
    Effect.mapError(
      () =>
        new RecordingFailure({
          message: `${name} is required for the recording notification driver`,
        }),
    ),
  );

const fail = (message: string): Effect.Effect<never, RecordingFailure> =>
  Effect.fail(new RecordingFailure({ message }));

const claimedAt = "2031-09-20T13:31:00.000Z";

const deliveredAt = "2031-09-20T13:31:01.000Z";

const recording = makeRecordingNotificationGateway(deliveredAt);

const databaseLayer = Layer.unwrap(
  Effect.map(requiredEnvironment(Schema.Redacted(Schema.NonEmptyString), "BACKEND_PG_URL"), (url) =>
    DatabaseLive({
      url,
      applicationName: "native-scheduling-recording-evidence",
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
// while the delivery runs, and restores the platform fetch when the scope closes.
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

const program = Effect.gen(function* () {
  const trap = yield* networkTrap;

  const result = yield* deliverNextRecruitmentInvitation(
    "native-scheduling-recording-claim",
    claimedAt,
  ).pipe(Effect.provide(Layer.mergeAll(recording.layer, authorityLayers)));

  if (!Predicate.isTagged(result, "Delivered")) {
    return yield* fail(`Expected one recorded invitation delivery, received ${result._tag}`);
  }

  if (recording.requests.length !== 1) {
    return yield* fail(
      `Expected one canonical notification request, received ${recording.requests.length}`,
    );
  }

  if (trap.providerNetworkRequests !== 0) {
    return yield* fail("The recording NotificationGateway performed a network request");
  }

  if (result.evidence.effectId !== recording.requests[0]?.effectId) {
    return yield* fail("Recording evidence does not identify the claimed notification request");
  }

  const requests = yield* Effect.forEach(recording.requests, (request) =>
    Schema.decodeEffect(Schema.fromJsonString(RecruitmentInvitationOutboxRequestSchema))(
      invitationPayloadForEvidence(request),
    ),
  );

  const evidence = {
    result: result._tag,
    claim: {
      effectId: result.claim.effectId,
      claimId: result.claim.claimId,
      attempts: result.claim.attempts,
    },
    notificationEvidence: result.evidence,
    requests,
    providerNetworkRequests: trap.providerNetworkRequests,
    responseCapabilityRedacted: true,
  };

  const evidencePath = yield* requiredEnvironment(
    Schema.NonEmptyString,
    "SCHEDULING_RECORDING_EVIDENCE_PATH",
  );

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const evidenceText = yield* jsonText(evidence);

  yield* fileSystem.makeDirectory(path.dirname(evidencePath), { recursive: true });
  yield* fileSystem.writeFileString(evidencePath, `${evidenceText}\n`);
  yield* Console.log(evidenceText);
});

BunRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(BunServices.layer)));
