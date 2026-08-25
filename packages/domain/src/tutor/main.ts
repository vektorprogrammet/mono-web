import { Cause, Effect, Result } from "effect";
import { writeStandardError, writeStandardOutput } from "../runtime-services.js";
import { canonicalJson } from "./evidence.js";
import { FIXTURE_ID, runTutorFixture } from "./fixture.js";

export const main = (args: ReadonlyArray<string>) =>
  args.length !== 1 || args[0] !== "--fixtures"
    ? writeStandardError("usage: bun run runtime/tutor-main.ts --fixtures\n").pipe(Effect.as(1))
    : Effect.gen(function* () {
        const run = yield* runTutorFixture();
        const summary = {
          fixtureId: FIXTURE_ID,
          scenarioCount: run.scenarioCount,
          statusCounts: run.statusCounts,
          reasonCounts: run.reasonCounts,
          eventCount: run.eventCount,
          descriptorCount: run.descriptorCount,
          evidenceDigest: run.evidence.digest,
          evidenceByteLength: run.evidence.bytes.length,
          counterexampleReceipts: run.counterexampleReceipts,
        };
        yield* writeStandardOutput(`${canonicalJson(summary)}\n${run.evidence.canonicalJson}\n`);
        return 0;
      }).pipe(
        Effect.catchCause((cause) => {
          const failure = Cause.findError(cause);
          const error = Result.isSuccess(failure) ? failure.success : undefined;
          const message = error instanceof Error ? error.message : "tutor fixture failed";
          return writeStandardError(
            `${canonicalJson({ fixtureId: FIXTURE_ID, error: message })}\n`,
          ).pipe(Effect.as(1));
        }),
      );

