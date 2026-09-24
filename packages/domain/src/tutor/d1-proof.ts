import { Schema, Match, Predicate, Cause, Context, Effect, Result } from "effect";
import { DomainProcess, writeStandardError, writeStandardOutput } from "../runtime-services.js";
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

export interface TutorD1ProofOperations {
  readonly run: Effect.Effect<D1ProofResult, Cause.UnknownError>;
}

export class TutorD1Proof extends Context.Service<TutorD1Proof, TutorD1ProofOperations>()(
  "@vektorprogrammet/domain/TutorD1Proof",
) {}

const errorTag = Match.type<unknown>().pipe(
  Match.when(Schema.is(Schema.Struct({ _tag: Schema.String })), (error) => error._tag),
  Match.when(Predicate.isError, (error) => error.name),
  Match.orElse(() => "UnknownError"),
);

const errorReason = Match.type<unknown>().pipe(
  Match.when(Schema.is(Schema.Struct({ reasonCode: Schema.String })), (error) => error.reasonCode),
  Match.when(Predicate.isError, (error) => error.name),
  Match.orElse(() => "UNKNOWN"),
);

export const main = (
  args: ReadonlyArray<string>,
): Effect.Effect<number, never, DomainProcess | TutorD1Proof> => {
  if (args.length !== 0) {
    return writeStandardError("usage: bun run runtime/tutor-d1-proof-main.ts\n").pipe(Effect.as(1));
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
        const error = Result.isSuccess(failure) ? failure.success.cause : undefined;

        return writeStandardError(
          `${canonicalJson({ specId: SPEC_ID, passed: false, error: `${errorTag(error)}:${errorReason(error)}` })}\n`,
        ).pipe(Effect.as(1));
      }),
    ),
  );
};
