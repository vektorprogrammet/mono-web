import { Effect, Schema } from "effect";
import type { InternalSdkError } from "../errors.js";
import { AdmissionApplicationDecodeError } from "../errors.js";
import type { Transport } from "../transport.js";
import {
  AdmissionApplicationSubmitInput,
  AdmissionApplicationSubmitResponse,
} from "../schemas/admission-application.js";

const decodeCanonical = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  value: unknown,
): Effect.Effect<A, AdmissionApplicationDecodeError> =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new AdmissionApplicationDecodeError()),
  );

export interface AdmissionApplicationsDomain {
  submit(
    input: typeof AdmissionApplicationSubmitInput.Type,
  ): Effect.Effect<typeof AdmissionApplicationSubmitResponse.Type, InternalSdkError>;
}

export function createAdmissionApplicationsDomain(transport: Transport): AdmissionApplicationsDomain {
  return {
    submit(input) {
      return decodeCanonical(AdmissionApplicationSubmitInput, input).pipe(
        Effect.flatMap((validInput) =>
          transport.post(
            "/api/applications",
            validInput,
            AdmissionApplicationSubmitResponse,
            { strict: true },
          ),
        ),
      );
    },
  };
}
