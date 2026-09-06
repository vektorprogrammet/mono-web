import { NativeProblem, ValidationProblem } from "@vektorprogrammet/http-api";
import { Schema } from "effect";

const ProblemBody = Schema.Union([ValidationProblem, NativeProblem]);
const NativeProblemSummary = Schema.Struct({
  status: Schema.Number,
  code: Schema.String,
  validation: Schema.optional(
    Schema.Struct({
      errors: Schema.Array(Schema.Struct({ pointer: Schema.String })),
    }),
  ),
});
export type NativeProblemSummary = typeof NativeProblemSummary.Type;

/** The generated SDK retains response headers around problem bodies. Validate the
 * canonical problem before projecting UI decisions; arbitrary thrown objects are
 * never treated as authorization or version-conflict decisions.
 * Extracted from the existing interview bridge's problem projection. */
export function nativeProblemFrom(error: unknown): NativeProblemSummary | undefined {
  const decode = Schema.decodeUnknownOption(ProblemBody, { onExcessProperty: "error" });
  const direct = decode(error);
  const problem =
    direct._tag === "Some"
      ? error
      : typeof error === "object" &&
          error !== null &&
          "body" in error &&
          decode(error.body)._tag === "Some"
        ? error.body
        : undefined;
  return problem === undefined
    ? undefined
    : Schema.decodeUnknownSync(NativeProblemSummary)(problem);
}
