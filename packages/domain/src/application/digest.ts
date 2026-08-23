import { canonicalJsonBytes, sha256Hex } from "../tutor/evidence.js";
export { canonicalJson } from "../tutor/evidence.js";
import type { PublicApplicationSubmitInput, SubmitPublicApplicationCommand } from "./schema.js";

export type PublicApplicationCommandPayload = PublicApplicationSubmitInput;

export const publicApplicationCommandPayload = (
  command: PublicApplicationSubmitInput | SubmitPublicApplicationCommand,
): PublicApplicationCommandPayload => ({
  commandId: command.commandId.trim(),
  departmentId: command.departmentId.trim(),
  firstName: command.firstName.trim(),
  lastName: command.lastName.trim(),
  phone: command.phone.trim(),
  email: command.email.trim().toLowerCase(),
  gender: command.gender,
  fieldOfStudyId: command.fieldOfStudyId.trim(),
  yearOfStudy: command.yearOfStudy,
});

export const publicApplicationCommandBytes = (
  command: PublicApplicationSubmitInput | SubmitPublicApplicationCommand,
): Uint8Array => canonicalJsonBytes(publicApplicationCommandPayload(command));

export const publicApplicationCommandDigest = (
  command: PublicApplicationSubmitInput | SubmitPublicApplicationCommand,
): string => sha256Hex(publicApplicationCommandBytes(command));

export const publicApplicationIdForCommand = (
  command: PublicApplicationSubmitInput | SubmitPublicApplicationCommand,
): string => `application-${publicApplicationCommandDigest(command).slice(0, 32)}`;

export const publicApplicantIdForCommand = (
  command: PublicApplicationSubmitInput | SubmitPublicApplicationCommand,
): string => `applicant-${publicApplicationCommandDigest(command).slice(0, 32)}`;
