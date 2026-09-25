import { isProblem, NativeProblem, problemBody, ValidationProblem } from "@vektorprogrammet/http-api";
import { Option, Schema } from "effect";

const ProblemBody = Schema.Union([ValidationProblem, NativeProblem]);

const decodeProblem = Schema.decodeUnknownOption(ProblemBody, { onExcessProperty: "error" });

export type NativeProblemSummary = typeof ProblemBody.Type;

/** Decode a problem failed by the generated SDK or a canonical direct problem body. */
export const nativeProblemFrom = (cause: unknown): NativeProblemSummary | undefined =>
  Option.getOrUndefined(decodeProblem(isProblem(cause) ? problemBody(cause) : cause));

/** Preserve transport failures and redirects while decoding native problem evidence. */
export const nativeFailureFrom = (
  cause: unknown,
): Error | Response | NativeProblemSummary | undefined =>
  !isProblem(cause) && (cause instanceof Error || cause instanceof Response)
    ? cause
    : nativeProblemFrom(cause);
