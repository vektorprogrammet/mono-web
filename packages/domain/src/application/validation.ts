import { Effect, Schema } from "effect";
import { PublicApplicationDecodeError } from "./errors.js";
import {
  isPublicApplicationEmail,
  isPublicApplicationInstant,
  isPublicApplicationName,
  isPublicApplicationPhone,
  PublicApplicationSubmitInputSchema,
  type PublicApplicationSubmitInput,
  type SubmitPublicApplicationCommand,
} from "./schema.js";

const invalidInput = new PublicApplicationDecodeError({
  message: "invalid public application input",
});

const normalizeSubmitInput = (
  input: PublicApplicationSubmitInput,
): Effect.Effect<PublicApplicationSubmitInput, PublicApplicationDecodeError> => {
  const commandId = input.commandId.trim();
  const departmentId = input.departmentId.trim();
  const firstName = input.firstName.trim();
  const lastName = input.lastName.trim();
  const phone = input.phone.trim();
  const email = input.email.trim();
  const fieldOfStudyId = input.fieldOfStudyId.trim();
  if (
    commandId.length === 0 ||
    departmentId.length === 0 ||
    fieldOfStudyId.length === 0 ||
    !isPublicApplicationName(firstName) ||
    !isPublicApplicationName(lastName) ||
    !isPublicApplicationPhone(phone) ||
    !isPublicApplicationEmail(email)
  ) {
    return Effect.fail(invalidInput);
  }
  return Effect.succeed({
    commandId,
    departmentId,
    firstName,
    lastName,
    phone,
    email: email.toLowerCase(),
    gender: input.gender,
    fieldOfStudyId,
    yearOfStudy: input.yearOfStudy,
  });
};

export const decodePublicApplicationSubmitInput = (
  input: unknown,
): Effect.Effect<PublicApplicationSubmitInput, PublicApplicationDecodeError> =>
  Schema.decodeUnknownEffect(PublicApplicationSubmitInputSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap(normalizeSubmitInput),
    Effect.mapError(() => invalidInput),
  );

export const decodeSubmitPublicApplicationInput = decodePublicApplicationSubmitInput;

export const decodeSubmitPublicApplicationCommand = (
  input: unknown,
): Effect.Effect<SubmitPublicApplicationCommand, PublicApplicationDecodeError> =>
  decodePublicApplicationSubmitInput(input).pipe(
    Effect.map((normalized) => ({ _tag: "SubmitPublicApplication" as const, ...normalized })),
  );

export const decodePublicApplicationNow = (
  now: unknown,
): Effect.Effect<string, PublicApplicationDecodeError> => {
  if (typeof now === "string" && isPublicApplicationInstant(now)) return Effect.succeed(now);
  return Effect.fail(
    new PublicApplicationDecodeError({ message: "invalid public application time" }),
  );
};
