import { Effect, Schema } from "effect";
import type { InternalSdkError } from "../errors.js";
import { PublicApplicationDecodeError } from "../errors.js";
import type { Transport } from "../transport.js";
import {
  PublicApplicationCatalog,
  PublicApplicationConfirmation,
  PublicApplicationSubmitInput,
  PublicApplicationSubmitResponse,
} from "../schemas/admission-application.js";

const publicDecodeOptions = {
  strict: true,
  decodeError: () => new PublicApplicationDecodeError(),
  errorFamily: "public_application" as const,
};

const decodeCanonical = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  value: unknown,
): Effect.Effect<A, PublicApplicationDecodeError> =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new PublicApplicationDecodeError()),
  );

export interface AdmissionApplicationsDomain {
  catalog(): Effect.Effect<typeof PublicApplicationCatalog.Type, InternalSdkError>;
  submit(
    input: typeof PublicApplicationSubmitInput.Type,
  ): Effect.Effect<typeof PublicApplicationSubmitResponse.Type, InternalSdkError>;
  confirmation(
    applicationId: string,
  ): Effect.Effect<typeof PublicApplicationConfirmation.Type, InternalSdkError>;
}

export function createAdmissionApplicationsDomain(transport: Transport): AdmissionApplicationsDomain {
  return {
    catalog() {
      return transport.get("/api/applications/catalog", PublicApplicationCatalog, undefined, publicDecodeOptions);
    },
    submit(input) {
      return decodeCanonical(PublicApplicationSubmitInput, input).pipe(
        Effect.flatMap((validInput) =>
          transport.post(
            "/api/applications",
            validInput,
            PublicApplicationSubmitResponse,
            publicDecodeOptions,
          ),
        ),
      );
    },
    confirmation(applicationId) {
      return transport.get(
        `/api/applications/${encodeURIComponent(applicationId)}/confirmation`,
        PublicApplicationConfirmation,
        undefined,
        publicDecodeOptions,
      );
    },
  };
}
