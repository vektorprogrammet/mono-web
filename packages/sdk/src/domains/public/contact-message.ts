import { Effect, Schema } from "effect";
import { Validation, type InternalSdkError } from "../../errors.js";
import { ContactMessageInput } from "../../schemas/contact-message.js";
import type { Transport } from "../../transport.js";

const decodeInput = (
  input: typeof ContactMessageInput.Type,
): Effect.Effect<typeof ContactMessageInput.Type, Validation> =>
  Schema.decodeUnknownEffect(ContactMessageInput)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(
      (error) =>
        new Validation({
          message: `Invalid contact message: ${error.message}`,
          fields: {},
        }),
    ),
  );

export interface PublicContactMessageDomain {
  submit(input: typeof ContactMessageInput.Type): Effect.Effect<void, InternalSdkError>;
}

export function createPublicContactMessageDomain(transport: Transport): PublicContactMessageDomain {
  return {
    submit(input) {
      return decodeInput(input).pipe(
        Effect.flatMap((validInput) => transport.postVoid("/api/contact_messages", validInput)),
      );
    },
  };
}
