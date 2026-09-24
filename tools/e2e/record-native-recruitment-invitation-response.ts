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
import { Predicate, Effect, Layer, Redacted, Schema } from "effect";

const databaseUrl = process.env.BACKEND_PG_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error("BACKEND_PG_URL is required for response recording evidence");
}

const deliveredAt = "2031-09-15T12:01:00.000Z";

const recording = makeRecordingNotificationGateway(deliveredAt);

const databaseLayer = DatabaseLive({
  url: Redacted.make(databaseUrl),
  applicationName: "native-invitation-response-recording-evidence",
  maxConnections: 1,
});

const admissionsLayer = AdmissionsLive.pipe(Layer.provide(databaseLayer));

const organizationLayer = OrganizationLive.pipe(Layer.provide(databaseLayer));

const profileLayer = ProfileLive.pipe(Layer.provide(Layer.merge(databaseLayer, organizationLayer)));

const authorityLayers = Layer.mergeAll(
  databaseLayer,
  admissionsLayer,
  organizationLayer,
  profileLayer,
);

let providerNetworkRequests = 0;

const originalFetch = globalThis.fetch;

globalThis.fetch = Object.assign(
  (..._arguments: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
    providerNetworkRequests += 1;

    return Promise.reject(new Error("The recording NotificationGateway attempted network access"));
  },
  {
    preconnect: () => {
      providerNetworkRequests += 1;
      throw new Error("The recording NotificationGateway attempted network access");
    },
  },
);

try {
  const results = [];

  for (let index = 0; index < 2; index += 1) {
    const result = await Effect.runPromise(
      Effect.scoped(
        deliverNextRecruitmentInvitationResponse(
          "native-invitation-response-recording-claim-" + String(index + 1),
          "2031-09-15T12:00:0" + String(index + 1) + ".000Z",
        ).pipe(Effect.provide(recording.layer), Effect.provide(authorityLayers)),
      ),
    );

    if (!Predicate.isTagged(result, "Delivered")) {
      throw new Error("Expected a recorded invitation-response delivery");
    }

    results.push({
      result: result._tag,
      claim: {
        effectId: result.claim.effectId,
        claimId: result.claim.claimId,
        attempts: result.claim.attempts,
      },
      notificationEvidence: result.evidence,
    });
  }

  if (recording.responseRequests.length !== 2) {
    throw new Error("Expected exactly two approved response requests");
  }

  if (providerNetworkRequests !== 0) {
    throw new Error("The recording NotificationGateway performed network access");
  }

  const responseRequests = recording.responseRequests.map((request) =>
    Schema.decodeSync(Schema.fromJsonString(RecruitmentInvitationResponseOutboxRequestSchema))(
      invitationResponsePayloadForEvidence(request),
    ),
  );

  process.stdout.write(
    JSON.stringify({ results, responseRequests, providerNetworkRequests }) + "\n",
  );
} finally {
  globalThis.fetch = originalFetch;
}
