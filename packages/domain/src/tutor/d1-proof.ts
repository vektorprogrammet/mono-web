import { Cause, Context, Effect, Result } from "effect";
import {
  DomainProcess,
  writeStandardError,
  writeStandardOutput,
} from "../runtime-services.js";
import { canonicalJson } from "./evidence.js";

const SPEC_ID = "0017";

export interface D1ProofResult {
  readonly passed: true;
  readonly caseCount: number;
  readonly reasonCounts: Readonly<Record<string, number>>;
  readonly evidenceByteLength: number;
  readonly evidenceSha256: string;
  readonly secondEvidenceSha256: string;
  readonly byteIdentical: boolean;
  readonly evidenceCanonicalJson: string;
}

export interface TutorD1ProofShape {
  readonly run: Effect.Effect<D1ProofResult, unknown>;
}

export class TutorD1Proof extends Context.Service<TutorD1Proof, TutorD1ProofShape>()(
  "@vektorprogrammet/domain/TutorD1Proof",
) {}

const errorTag = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : error instanceof Error
      ? error.name
      : "UnknownError";

const errorReason = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "reasonCode" in error &&
  typeof error.reasonCode === "string"
    ? error.reasonCode
    : error instanceof Error
      ? error.name
      : "UNKNOWN";

export const main = (
  args: ReadonlyArray<string>,
): Effect.Effect<number, never, DomainProcess | TutorD1Proof> => {
  if (args.length !== 0) {
    return writeStandardError("usage: bun run runtime/tutor-d1-proof-main.ts\n").pipe(
      Effect.as(1),
    );
  }

  return TutorD1Proof.use(({ run }) =>
    run.pipe(
      Effect.flatMap((result) =>
        writeStandardOutput(
          `${canonicalJson({
            specId: SPEC_ID,
            passed: result.passed,
            caseCount: result.caseCount,
            reasonCounts: result.reasonCounts,
            evidenceByteLength: result.evidenceByteLength,
            evidenceSha256: result.evidenceSha256,
            secondEvidenceSha256: result.secondEvidenceSha256,
            byteIdentical: result.byteIdentical,
          })}\n${result.evidenceCanonicalJson}\n`,
        ).pipe(Effect.as(0)),
      ),
      Effect.catchCause((cause) => {
        const failure = Cause.findError(cause);
        const error = Result.isSuccess(failure) ? failure.success : undefined;
        return writeStandardError(
          `${canonicalJson({ specId: SPEC_ID, passed: false, error: `${errorTag(error)}:${errorReason(error)}` })}\n`,
        ).pipe(Effect.as(1));
      }),
    ),
  );
};
