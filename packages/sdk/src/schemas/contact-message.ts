/**
 * Client schema for public contact-message input.
 *
 * @since 0.2.0
 */
import { Schema } from "effect";
import { DepartmentId } from "./organization.js";

const nonEmptyText = (message: string) =>
  Schema.String.pipe(
    Schema.check(Schema.makeFilter((value) => value.trim().length > 0, { message })),
  );

const Email = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()), {
      message: "must be a valid email address",
    }),
  ),
);

const Message = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => value.trim().length > 0 && [...value].length <= 5000, {
      message: "must be a non-empty message of at most 5000 characters",
    }),
  ),
);

export class ContactMessageInput extends Schema.Class<ContactMessageInput>("ContactMessageInput")({
  name: nonEmptyText("must be a non-empty name"),
  email: Email,
  departmentId: DepartmentId,
  subject: nonEmptyText("must be a non-empty subject"),
  message: Message,
}) {}

export const ContactMessageInputSchema = ContactMessageInput;
