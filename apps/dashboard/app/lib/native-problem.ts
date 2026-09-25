import { isProblem, NativeProblem, problemBody, ValidationProblem } from "@vektorprogrammet/http-api";
import { Option, Schema } from "effect";

const ProblemBody = Schema.Union([ValidationProblem, NativeProblem]);

const decodeProblem = Schema.decodeUnknownOption(ProblemBody, { onExcessProperty: "error" });

export type NativeProblemSummary = typeof ProblemBody.Type;

/**
 * Decode the `Problem` the generated SDK failed with. Pass the SDK cause unchanged:
 * a copy, a re-decoded value, or any other problem-shaped object is not problem evidence.
 */
export const nativeProblemFrom = (cause: unknown): NativeProblemSummary | undefined =>
  isProblem(cause) ? Option.getOrUndefined(decodeProblem(problemBody(cause))) : undefined;

/** Preserve transport failures and redirects while decoding native problem evidence. */
export const nativeFailureFrom = (
  cause: unknown,
): Error | Response | NativeProblemSummary | undefined =>
  isProblem(cause)
    ? nativeProblemFrom(cause)
    : cause instanceof Error || cause instanceof Response
      ? cause
      : undefined;
