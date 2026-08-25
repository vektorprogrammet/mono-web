import {
  nodeArguments,
  setNodeExitCode,
  writeStandardErrorAtNodeBoundary,
  writeStandardOutputAtNodeBoundary,
} from "../../runtime/node.js";
import { canonicalJson } from "./evidence.js";
import { FIXTURE_ID, runTutorFixture } from "./fixture.js";

export const main = (args: ReadonlyArray<string> = nodeArguments()): number => {
  if (args.length !== 1 || args[0] !== "--fixtures") {
    writeStandardErrorAtNodeBoundary("usage: bun run src/tutor/main.ts --fixtures\n");
    return 1;
  }

  try {
    const run = runTutorFixture();
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
    writeStandardOutputAtNodeBoundary(`${canonicalJson(summary)}\n${run.evidence.canonicalJson}\n`);
    return 0;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "tutor fixture failed";
    writeStandardErrorAtNodeBoundary(
      `${canonicalJson({ fixtureId: FIXTURE_ID, error: message })}\n`,
    );
    return 1;
  }
};

if (import.meta.main) setNodeExitCode(main());
