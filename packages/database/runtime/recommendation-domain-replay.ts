/** Independent real-domain receipt replay after immutable applicant identity becomes known. */
import assert from "node:assert/strict";
import { Effect, Layer, Redacted, Schema } from "effect";
import { DatabaseLive } from "../src/layers.js";
import { Database } from "../src/service.js";
import { OrganizationLive } from "../src/organization/postgres-layer.js";
import { finalizeInterview } from "../src/recruitment/conduct-postgres.js";
import {
  FinalizeInterviewCommandSchema,
  RecruitmentActorSchema,
} from "@vektorprogrammet/domain/recruitment";
const url = process.env.JOURNEY_SEED_PG_URL!;
assert.equal(new URL(url).hostname, "127.0.0.1");
const layer = OrganizationLive.pipe(
  Layer.provideMerge(
    DatabaseLive({
      url: Redacted.make(url),
      applicationName: "recommendation-domain-replay",
      maxConnections: 1,
    }),
  ),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* Database;
    const rows = yield* sql<{
      command: unknown;
    }>`SELECT command_json AS command FROM public.recruitment_interview_lifecycle_command_receipts WHERE interview_id='interview-recommendation-no'`;
    const command = Schema.decodeUnknownSync(FinalizeInterviewCommandSchema)(rows[0]!.command);
    const actor = Schema.decodeUnknownSync(RecruitmentActorSchema)({
      _tag: "Member",
      personId: "journey-conduct-leader-0063",
      departmentId: "department-native-conduct-0063",
      active: true,
    });
    return yield* finalizeInterview(command, { actor, now: new Date().toISOString() }).pipe(
      Effect.flip,
    );
  }).pipe(Effect.provide(layer)),
);
assert.equal(result._tag, "RecruitmentScopeDenied");
console.log("Known self denied before real domain receipt replay");
