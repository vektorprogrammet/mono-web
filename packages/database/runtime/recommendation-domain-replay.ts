import { PersonId, DepartmentId } from "@vektorprogrammet/domain/organization";
/** Independent real-domain receipt replay after immutable applicant identity becomes known. */
import assert from "node:assert/strict";
import { Config, Console, DateTime, Effect, Layer, Redacted, Schema } from "effect";
import { DatabaseLive } from "../src/layers.js";
import { TestPlatform } from "../src/test-support/platform.js";
import { Database } from "../src/service.js";
import { OrganizationLive } from "../src/organization/postgres-layer.js";
import { finalizeInterview } from "../src/recruitment/conduct-postgres.js";
import {
  FinalizeInterviewCommandSchema,
  RecruitmentActorSchema,
} from "@vektorprogrammet/domain/recruitment";

const program = Effect.gen(function* () {
  const url = yield* Config.String("JOURNEY_SEED_PG_URL");

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

  const result = yield* Effect.gen(function* () {
    const sql = yield* Database;

    const rows = yield* sql<{
      command: unknown;
    }>`SELECT command_json AS command FROM public.recruitment_interview_lifecycle_command_receipts WHERE interview_id='interview-recommendation-no'`;

    const command = yield* Schema.decodeUnknownEffect(FinalizeInterviewCommandSchema)(
      rows[0]!.command,
    );

    const actor = yield* Schema.decodeEffect(RecruitmentActorSchema)(
      RecruitmentActorSchema.cases.Member.make({
        personId: PersonId.make("journey-conduct-leader-0063"),
        departmentId: DepartmentId.make("department-native-conduct-0063"),
        active: true,
      }),
    );

    const now = DateTime.formatIso(yield* DateTime.now);

    return yield* finalizeInterview(command, { actor, now }).pipe(Effect.flip);
  }).pipe(Effect.provide(layer));

  assert.equal(result._tag, "RecruitmentScopeDenied");

  yield* Console.log("Known self denied before real domain receipt replay");
});

void Effect.runPromise(program.pipe(Effect.provide(TestPlatform))).catch((cause: unknown) => {
  process.stderr.write(`${String(cause)}\n`);
  process.exitCode = 1;
});
