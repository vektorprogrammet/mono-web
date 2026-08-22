import { Effect, Schema } from "effect";
import { AdmissionApplicationDecodeError } from "./errors.js";
import { StableIdSchema } from "./schema.js";

export const AdmissionApplicationSchema = Schema.Struct({
  id: StableIdSchema,
  applicantId: StableIdSchema,
  admissionPeriodId: StableIdSchema,
});
export type AdmissionApplication = typeof AdmissionApplicationSchema.Type;

const SubmitAdmissionApplicationFields = {
  commandId: StableIdSchema,
  applicantId: StableIdSchema,
  departmentId: StableIdSchema,
};

export const SubmitAdmissionApplicationInputSchema = Schema.Struct(SubmitAdmissionApplicationFields);
export type SubmitAdmissionApplicationInput = typeof SubmitAdmissionApplicationInputSchema.Type;

export const SubmitAdmissionApplicationCommandSchema = Schema.TaggedUnion({
  SubmitAdmissionApplication: SubmitAdmissionApplicationFields,
});
export type SubmitAdmissionApplicationCommand = typeof SubmitAdmissionApplicationCommandSchema.Type;

export interface AdmissionApplicationSubmitContext {
  readonly now: string;
  /** Optional transport-generated application identity; otherwise derived from command bytes. */
  readonly applicationId?: string;
}

export interface AdmissionApplicationTransactionResult {
  readonly application: AdmissionApplication;
  readonly replayed: boolean;
}

export const decodeSubmitAdmissionApplicationInput = (
  input: unknown,
): Effect.Effect<SubmitAdmissionApplicationInput, AdmissionApplicationDecodeError> =>
  Schema.decodeUnknownEffect(SubmitAdmissionApplicationInputSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => new AdmissionApplicationDecodeError({ message: String(cause) })),
  );

export const decodeSubmitAdmissionApplicationCommand = (
  input: unknown,
): Effect.Effect<SubmitAdmissionApplicationCommand, AdmissionApplicationDecodeError> =>
  Schema.decodeUnknownEffect(SubmitAdmissionApplicationCommandSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError((cause) => new AdmissionApplicationDecodeError({ message: String(cause) })),
  );
