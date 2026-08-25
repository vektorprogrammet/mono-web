import { Effect, Schema } from "effect";
import {
  CreateDepartmentCommandSchema,
  CreateDepartmentResultSchema,
  CreateFieldOfStudyCommandSchema,
  CreateFieldOfStudyResultSchema,
  CreateTeamCommandSchema,
  CreateTeamResultSchema,
  type CreateDepartmentCommand,
  type CreateDepartmentResult,
  type CreateFieldOfStudyCommand,
  type CreateFieldOfStudyResult,
  type CreateTeamCommand,
  type CreateTeamResult,
} from "../../schemas/organization.js";
import { OrganizationDecodeError, type InternalSdkError } from "../../errors.js";
import type { Transport } from "../../transport.js";

export interface AdminOrganizationDomain {
  createDepartment(
    command: CreateDepartmentCommand,
  ): Effect.Effect<CreateDepartmentResult, InternalSdkError>;
  createTeam(command: CreateTeamCommand): Effect.Effect<CreateTeamResult, InternalSdkError>;
  createFieldOfStudy(
    command: CreateFieldOfStudyCommand,
  ): Effect.Effect<CreateFieldOfStudyResult, InternalSdkError>;
}

const strictAdminOrganization = {
  strict: true,
  errorFamily: "organization" as const,
  decodeError: () => new OrganizationDecodeError(),
  expectedStatus: [200, 201] as const,
  headers: { Accept: "application/json" },
};

const strictDecode = <S extends Schema.ConstraintDecoder<unknown, never>>(
  schema: S,
  value: unknown,
): Effect.Effect<S["Type"], OrganizationDecodeError> =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new OrganizationDecodeError()),
  );

export const createAdminOrganizationDomain = (transport: Transport): AdminOrganizationDomain => ({
  createDepartment(command) {
    return strictDecode(CreateDepartmentCommandSchema, command).pipe(
      Effect.flatMap((validCommand) =>
        transport.post(
          "/api/admin/departments",
          validCommand,
          CreateDepartmentResultSchema,
          strictAdminOrganization,
        ),
      ),
    );
  },

  createTeam(command) {
    return strictDecode(CreateTeamCommandSchema, command).pipe(
      Effect.flatMap((validCommand) =>
        transport.post(
          "/api/admin/teams",
          validCommand,
          CreateTeamResultSchema,
          strictAdminOrganization,
        ),
      ),
    );
  },

  createFieldOfStudy(command) {
    return strictDecode(CreateFieldOfStudyCommandSchema, command).pipe(
      Effect.flatMap((validCommand) =>
        transport.post(
          "/api/admin/field-of-studies",
          validCommand,
          CreateFieldOfStudyResultSchema,
          strictAdminOrganization,
        ),
      ),
    );
  },
});
