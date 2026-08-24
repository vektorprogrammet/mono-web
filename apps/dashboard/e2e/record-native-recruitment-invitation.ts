import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseLive } from "../../../packages/database/src/index.ts";
import {
  deliverNextRecruitmentInvitation,
  invitationPayloadForEvidence,
} from "../../../packages/domain/src/recruitment/index.ts";
import { makeRecordingNotificationGateway } from "../../../packages/domain/src/notification/index.ts";
import { Effect, Redacted } from "effect";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the recording notification driver`);
  }
  return value;
};

const claimedAt = "2031-09-20T13:31:00.000Z";
const deliveredAt = "2031-09-20T13:31:01.000Z";
const recording = makeRecordingNotificationGateway(deliveredAt);
const databaseLayer = DatabaseLive({
  url: Redacted.make(requiredEnvironment("BACKEND_PG_URL")),
  applicationName: "native-scheduling-recording-evidence",
  maxConnections: 1,
});

let providerNetworkRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = ((..._arguments: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
  providerNetworkRequests += 1;
  return Promise.reject(new Error("The recording NotificationGateway attempted network access"));
}) as typeof fetch;

try {
  const result = await Effect.runPromise(
    Effect.scoped(
      deliverNextRecruitmentInvitation("native-scheduling-recording-claim", claimedAt).pipe(
        Effect.provide(recording.layer),
        Effect.provide(databaseLayer),
      ),
    ),
  );
  if (result._tag !== "Delivered") {
    throw new Error(`Expected one recorded invitation delivery, received ${result._tag}`);
  }
  if (recording.requests.length !== 1) {
    throw new Error(`Expected one canonical notification request, received ${recording.requests.length}`);
  }
  if (providerNetworkRequests !== 0) {
    throw new Error("The recording NotificationGateway performed a network request");
  }
  if (result.evidence.effectId !== recording.requests[0]?.effectId) {
    throw new Error("Recording evidence does not identify the claimed notification request");
  }

  const requests = recording.requests.map((request) =>
    JSON.parse(invitationPayloadForEvidence(request)) as unknown,
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
    providerNetworkRequests,
    responseCapabilityRedacted: true,
  };
  const evidencePath = requiredEnvironment("SCHEDULING_RECORDING_EVIDENCE_PATH");
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} finally {
  globalThis.fetch = originalFetch;
}
