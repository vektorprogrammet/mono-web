import { NativeProblem } from "@vektorprogrammet/http-api";
import { Schema } from "effect";

const NativeProblemSummary = Schema.Struct({ status: Schema.Number, code: Schema.String });
type NativeProblemSummary = typeof NativeProblemSummary.Type;

/** The generated SDK retains response headers around problem bodies. Validate the
 * canonical problem before projecting UI decisions; arbitrary thrown objects are
 * never treated as authorization or version-conflict decisions.
 * Extracted from the existing interview bridge's problem projection. */
export function nativeProblemFrom(error: unknown): NativeProblemSummary | undefined {
  const problem = Schema.is(NativeProblem)(error)
    ? error
    : typeof error === "object" &&
        error !== null &&
        "body" in error &&
        Schema.is(NativeProblem)(error.body)
      ? error.body
      : undefined;
  return problem === undefined
    ? undefined
    : Schema.decodeUnknownSync(NativeProblemSummary)(problem);
}
