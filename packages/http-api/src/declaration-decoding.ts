/**
 * The one place that turns a declaration-time Schema decode or encode into a thrown `SchemaError`.
 *
 * EX-0039: the effx compiler calls an access annotator and a problem registry synchronously with
 * the literals of one declaration, and a module-level annotation example is a constant. None of
 * them can return an Effect, so an invalid declaration fails by throwing. `Result.getOrThrow`
 * appears in this module only.
 *
 * @since 0.1.0
 */
import { flow, Result, Schema, type SchemaAST } from "effect";

/**
 * Builds a synchronous decoder of one declared spec whose mismatch throws `SchemaError`.
 *
 * @remarks
 * Use it for an input that a declaration fixes before any request exists: the spec that effx hands
 * to an access annotator, or the codes that it hands to a problem registry. The effx contract is a
 * synchronous call, so the mismatch is the build-time failure of that declaration and cannot occur
 * once the declaring module has loaded. `onExcessProperty: "error"` makes an undeclared member a
 * mismatch too.
 *
 * @sideEffects Throws `SchemaError` when the input does not decode, at the call of the returned
 * decoder, which is module load or `effx build`.
 *
 * @example
 * ```ts
 * const decodeProfileAccess = decodeDeclaredOrThrow(ProfileAccess, { onExcessProperty: "error" });
 * export const profileAccessAnnotations = (input: HttpAccessAnnotationSpec) =>
 *   toAnnotations(decodeProfileAccess(input));
 * ```
 *
 * @avoid Decoding a request, row, message, or environment value with it. Runtime input needs
 * `Schema.decodeUnknownEffect` and a typed failure, not a throw.
 *
 * @param schema - The service-free schema of the declared spec.
 * @param options - Parse options; the access specs pass `{ onExcessProperty: "error" }`.
 * @returns A decoder of `unknown` that returns the decoded `Type` or throws.
 */
export const decodeDeclaredOrThrow = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  options?: SchemaAST.ParseOptions,
) => flow(Schema.decodeUnknownResult(schema, options), Result.getOrThrow);

/**
 * Builds a synchronous decoder of one constant example, typed by the schema's `Encoded` side,
 * whose mismatch throws `SchemaError`.
 *
 * @remarks
 * Use it for a module-level constant that documents the public representation. The compiler
 * checks the argument against `S["Encoded"]`, so only a rule that a type cannot express, such as
 * an instant format, remains for the runtime check.
 *
 * @sideEffects Throws `SchemaError` when the constant does not decode, at module load.
 *
 * @example
 * ```ts
 * const decodeConductObservation = decodeExampleOrThrow(RecruitmentInterviewConductObservationSchema);
 * ```
 *
 * @avoid Decoding data that was not written in the module. Runtime input needs
 * `Schema.decodeEffect` or `Schema.decodeUnknownEffect`.
 *
 * @param schema - The service-free schema of the example.
 * @returns A decoder of `S["Encoded"]` that returns the decoded `Type` or throws.
 */
export const decodeExampleOrThrow = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  flow(Schema.decodeResult(schema), Result.getOrThrow);

/**
 * Builds a synchronous encoder of one constant example whose mismatch throws `SchemaError`.
 *
 * @remarks
 * Use it for the `Encoded` form of a module-level constant that annotates the public
 * representation, because OpenAPI documents the encoded side. The constant was decoded or built
 * from the schema in the same module, so encoding it cannot fail once the module has loaded.
 *
 * @sideEffects Throws `SchemaError` when the constant does not encode, at module load.
 *
 * @example
 * ```ts
 * const example = encodeExampleOrThrow(RecruitmentInterviewConductObservationSchema)(observation);
 * ```
 *
 * @avoid Encoding a value that a request or a row produced. Runtime values need
 * `Schema.encodeEffect` and a typed failure.
 *
 * @param schema - The service-free schema of the example.
 * @returns An encoder of `S["Type"]` that returns the encoded form or throws.
 */
export const encodeExampleOrThrow = <S extends Schema.ConstraintEncoder<unknown>>(schema: S) =>
  flow(Schema.encodeResult(schema), Result.getOrThrow);
