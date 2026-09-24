import { NativeProblem, ValidationProblem } from "@vektorprogrammet/http-api";
import { flow, Option, Predicate, Schema } from "effect";

const ProblemBody = Schema.Union([ValidationProblem, NativeProblem]);

const decodeProblem = Schema.decodeUnknownOption(ProblemBody, { onExcessProperty: "error" });

export type NativeProblemSummary = typeof ProblemBody.Type;

/** Decode a canonical direct problem or the generated SDK response body. */
export const nativeProblemFrom = flow(
  Schema.decodeUnknownOption(Schema.Union([Schema.Struct({ body: Schema.Json }), Schema.Json])),
  Option.flatMap(source => decodeProblem(Predicate.isObject(source) && "body" in source ? source.body : source)),
  Option.getOrUndefined,
);

/** Preserve transport failures and redirects while decoding native problem evidence. */
export const nativeFailureFrom = flow(
  Schema.decodeUnknownOption(Schema.Union([
    Schema.instanceOf(Error),
    Schema.instanceOf(Response),
    Schema.Struct({ body: Schema.Json }),
    Schema.Json,
  ])),
  Option.map(source => source instanceof Error || source instanceof Response ? source : nativeProblemFrom(source)),
  Option.getOrUndefined,
);
