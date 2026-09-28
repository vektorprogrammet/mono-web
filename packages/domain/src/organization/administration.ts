import { flow, Effect, Schema } from "effect";
import { dual } from "effect/Function";
import { canonicalJsonBytes, sha256Hex } from "../shared-kernel/index.js";
import { OrganizationDecodeError } from "./errors.js";
import {
  CreateDepartmentCommandSchema,
  CreateFieldOfStudyCommandSchema,
  CreateTeamCommandSchema,
  OrganizationCreateCommandSchema,
  type OrganizationCommandId,
  type OrganizationCreateCommand,
  type OrganizationEntityKind,
} from "./administration-schema.js";
import {
  DepartmentId,
  FieldOfStudyId,
  TeamId,
  type DepartmentId as DepartmentIdType,
  type FieldOfStudyId as FieldOfStudyIdType,
  type TeamId as TeamIdType,
} from "./schema.js";

const decodeError = (operation: string, cause: unknown) =>
  OrganizationDecodeError.make({ operation, message: String(cause) });

export const decodeCreateDepartmentCommand = flow(
  Schema.decodeUnknownEffect(CreateDepartmentCommandSchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError((cause) => decodeError("decode CreateDepartment command", cause)),
);

export const decodeCreateTeamCommand = flow(
  Schema.decodeUnknownEffect(CreateTeamCommandSchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError((cause) => decodeError("decode CreateTeam command", cause)),
);

export const decodeCreateFieldOfStudyCommand = flow(
  Schema.decodeUnknownEffect(CreateFieldOfStudyCommandSchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError((cause) => decodeError("decode CreateFieldOfStudy command", cause)),
);

export const decodeOrganizationCreateCommand = flow(
  Schema.decodeUnknownEffect(OrganizationCreateCommandSchema, {
    onExcessProperty: "error",
  }),
  Effect.mapError((cause) => decodeError("decode organization create command", cause)),
);

export const organizationCommandBytes = (command: OrganizationCreateCommand): Uint8Array =>
  canonicalJsonBytes(command);

export const organizationCommandDigest = (command: OrganizationCreateCommand): string =>
  sha256Hex(organizationCommandBytes(command));

export const organizationEntityDigest: {
  (commandId: OrganizationCommandId): (entityKind: OrganizationEntityKind) => string;
  (entityKind: OrganizationEntityKind, commandId: OrganizationCommandId): string;
} = dual(2, (entityKind: OrganizationEntityKind, commandId: OrganizationCommandId): string =>
  sha256Hex(canonicalJsonBytes({ entityKind, commandId })),
);

export const departmentIdForCommand = (commandId: OrganizationCommandId): DepartmentIdType =>
  DepartmentId.make(`department-${organizationEntityDigest("Department", commandId)}`);

export const teamIdForCommand = (commandId: OrganizationCommandId): TeamIdType =>
  TeamId.make(`team-${organizationEntityDigest("Team", commandId)}`);

export const fieldOfStudyIdForCommand = (commandId: OrganizationCommandId): FieldOfStudyIdType =>
  FieldOfStudyId.make(`field-of-study-${organizationEntityDigest("FieldOfStudy", commandId)}`);
