/**
 * Shared schemas and examples for the generated Organization HTTP group.
 *
 * @since 0.1.0
 */
import {
  DepartmentId,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  FieldOfStudyId,
  PersonId,
  SemesterId,
  TeamId,
  TeamJsonSchema,
  type DepartmentJson,
  type FieldOfStudyJson,
  type TeamJson,
} from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";

export {
  DepartmentId,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  PersonId,
  SemesterId,
  TeamJsonSchema,
};

export type { DepartmentJson, FieldOfStudyJson, TeamJson };

/**
 * Reach-scoped organization query. Repeated values remain representable because
 * the current transport selects the first value.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const OrganizationScopeQuery = {
  department: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  semester: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
};

/**
 * Mailing-list projection selector.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const MailingListQuery = {
  ...OrganizationScopeQuery,
  type: Schema.optional(
    Schema.Union([
      Schema.Literals(["assistants", "team", "all"]),
      Schema.Array(Schema.Literals(["assistants", "team", "all"])),
    ]),
  ),
};

/**
 * Strict team-interest response compatible with the existing Hydra envelope.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const TeamInterestResponse = Schema.Struct({
  "hydra:member": Schema.Array(
    Schema.Struct({ id: Schema.Int, userName: Schema.String, teamName: Schema.String }),
  ),
  "hydra:totalItems": Schema.Int,
}).annotate({
  identifier: "TeamInterestResponse",
  description: "Scoped team-interest rows.",
  examples: [
    {
      "hydra:member": [{ id: 1, userName: "ming.medlem", teamName: "Rekruttering" }],
      "hydra:totalItems": 1,
    },
  ],
});

/**
 * Projected mailing list.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const MailingListResponse = Schema.Array(
  Schema.Struct({ name: Schema.String, emails: Schema.Array(Schema.String) }),
).annotate({
  identifier: "MailingListResponse",
  description: "Scoped mailing-list projections.",
  examples: [[{ name: "leder-trondheim", emails: ["lina.leder@example.org"] }]],
});

/**
 * Representative department JSON projection.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const DepartmentExample = {
  departmentId: DepartmentId.make("1"),
  name: "Datateknologi",
  shortName: "DAT",
  email: "datateknologi@example.org",
  address: "Sem Sælands vei 1",
  city: "Trondheim",
  latitude: null,
  longitude: null,
  slackChannel: null,
  logoPath: null,
  active: true,
  revision: 0,
} as const;

/**
 * Representative team JSON projection.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const TeamExample = {
  teamId: TeamId.make("rekruttering"),
  departmentId: DepartmentId.make("1"),
  name: "Rekruttering",
  shortName: "REK",
  shortDescription: "Interviews applicants",
  description: "Interviews applicants and runs the admission process.",
  email: "rekruttering@example.org",
  deadline: "2026-09-15T23:59:59.999Z",
  acceptApplication: true,
  active: true,
  revision: 0,
} as const;

/**
 * Representative field-of-study JSON projection.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const FieldOfStudyExample = {
  fieldOfStudyId: FieldOfStudyId.make("datateknologi"),
  departmentId: DepartmentId.make("1"),
  name: "Datateknologi",
  shortName: "DAT",
  active: true,
  revision: 0,
} as const;

/** Source schema for the three conditional public directory responses. */
export const DepartmentDirectoryResponse = Schema.Array(
  DepartmentJsonSchema.annotate({
    identifier: "DepartmentJson",
    description: "One native department directory row.",
    examples: [DepartmentExample],
  }),
);

export const TeamDirectoryResponse = Schema.Array(
  TeamJsonSchema.annotate({
    identifier: "TeamJson",
    description: "One native team directory row.",
    examples: [TeamExample],
  }),
);

export const FieldOfStudyDirectoryResponse = Schema.Array(
  FieldOfStudyJsonSchema.annotate({
    identifier: "FieldOfStudyJson",
    description: "One native field-of-study directory row.",
    examples: [FieldOfStudyExample],
  }),
);

/** Keep the shared query fields as an object for existing application consumers. */
export const OrganizationScopeQuerySchema = Schema.Struct(OrganizationScopeQuery);

export const MailingListQuerySchema = Schema.Struct(MailingListQuery);

export const EmptyOrganizationInput = Schema.Struct({});

export {
  AppointmentManagement,
  BoardRosters,
  OrganizationLifecycleCommand,
  OrganizationLifecycleResult,
} from "@vektorprogrammet/domain/organization";

export {
  DelegableCapability,
  DelegationArea,
  DelegationCommand,
  DelegationManagement,
  DelegationResult,
  OrganizationCapability,
} from "@vektorprogrammet/domain/authz";
