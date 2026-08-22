import { Effect, Schema } from "effect";
import type { InternalSdkError } from "../errors.js";
import { AdmissionPeriodDecodeError } from "../errors.js";
import type { Transport } from "../transport.js";
import {
  AdmissionCommandId,
  AdmissionPeriod,
  AdmissionPeriodCommandObservation,
  AdmissionPeriodCreateInput,
  AdmissionPeriodId,
  AdmissionPeriodPage,
  AdmissionPeriodProjection,
  AdmissionPeriodReviseInput,
  AdmissionRevision,
} from "../schemas/admission-period.js";

const decodeCanonical = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  value: unknown,
): Effect.Effect<A, AdmissionPeriodDecodeError> =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new AdmissionPeriodDecodeError()),
  );

export interface AdmissionPeriodsDomain {
  listForManagement(): Effect.Effect<typeof AdmissionPeriodPage.Type, InternalSdkError>;
  create(
    input: typeof AdmissionPeriodCreateInput.Type,
  ): Effect.Effect<typeof AdmissionPeriodCommandObservation.Type, InternalSdkError>;
  revise(
    admissionPeriodId: typeof AdmissionPeriodId.Type,
    input: typeof AdmissionPeriodReviseInput.Type,
  ): Effect.Effect<typeof AdmissionPeriodCommandObservation.Type, InternalSdkError>;
  listOpen(): Effect.Effect<typeof AdmissionPeriodPage.Type, InternalSdkError>;
}

export function createAdmissionPeriodsDomain(transport: Transport): AdmissionPeriodsDomain {
  return {
    listForManagement() {
      return transport.get(
        "/api/admin/admission-periods",
        AdmissionPeriodPage,
        undefined,
        { strict: true },
      );
    },

    create(input) {
      return decodeCanonical(AdmissionPeriodCreateInput, input).pipe(
        Effect.flatMap((validInput) =>
          transport.post(
            "/api/admin/admission-periods",
            validInput,
            AdmissionPeriodCommandObservation,
            { strict: true },
          ),
        ),
      );
    },

    revise(admissionPeriodId, input) {
      return decodeCanonical(AdmissionPeriodId, admissionPeriodId).pipe(
        Effect.flatMap((validId) =>
          decodeCanonical(AdmissionPeriodReviseInput, input).pipe(
            Effect.flatMap((validInput) =>
              transport.post(
                `/api/admin/admission-periods/${encodeURIComponent(validId)}/revise`,
                validInput,
                AdmissionPeriodCommandObservation,
                { strict: true },
              ),
            ),
          ),
        ),
      );
    },

    listOpen() {
      return transport.get(
        "/api/admission-periods/open",
        AdmissionPeriodPage,
        undefined,
        { strict: true },
      );
    },
  };
}

export type AdmissionPeriodPageItem = typeof AdmissionPeriodProjection.Type;
export type AdmissionPeriodCommandId = typeof AdmissionCommandId.Type;
export type AdmissionPeriodRevision = typeof AdmissionRevision.Type;
export type AdmissionPeriodValue = typeof AdmissionPeriod.Type;
