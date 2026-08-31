/**
 * Public HTTP contracts for organization queries and commands.
 *
 * @since 0.1.0
 */
import {
  CreateDepartmentCommandSchema,
  CreateDepartmentResultSchema,
  CreateFieldOfStudyCommandSchema,
  CreateFieldOfStudyResultSchema,
  CreateTeamCommandSchema,
  CreateTeamResultSchema,
  DepartmentId,
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  FieldOfStudyId,
  OrganizationCommandId,
  TeamId,
  TeamJsonSchema,
} from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { errorBody, operationAnnotations, SessionSecurity } from "./common.js";

/**
 * Leader-scoped organization query. Repeated values remain representable because
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

const OrganizationForbiddenResponse = errorBody(
  "OrganizationForbiddenResponse",
  ["OrganizationRoleDenied"],
  403,
);
const OrganizationConflictResponse = errorBody(
  "OrganizationConflictResponse",
  ["OrganizationCommandConflict"],
  409,
);
const OrganizationTooLargeResponse = errorBody(
  "OrganizationTooLargeResponse",
  ["RequestBodyTooLarge"],
  413,
);
const OrganizationDecodeResponse = errorBody(
  "OrganizationDecodeResponse",
  ["OrganizationInvalidReference", "OrganizationDecodeError"],
  422,
);
const OrganizationUnavailableResponse = errorBody(
  "OrganizationUnavailableResponse",
  ["OrganizationPersistenceError"],
  503,
);
const PublicOrganizationErrors = [
  OrganizationDecodeResponse,
  OrganizationUnavailableResponse,
] as const;
const AdminOrganizationErrors = [
  OrganizationForbiddenResponse,
  OrganizationConflictResponse,
  OrganizationTooLargeResponse,
  OrganizationDecodeResponse,
  OrganizationUnavailableResponse,
] as const;
const CreateDepartmentSuccess = [
  CreateDepartmentResultSchema.pipe(HttpApiSchema.status(200)),
  CreateDepartmentResultSchema.pipe(HttpApiSchema.status(201)),
] as const;
const CreateTeamSuccess = [
  CreateTeamResultSchema.pipe(HttpApiSchema.status(200)),
  CreateTeamResultSchema.pipe(HttpApiSchema.status(201)),
] as const;
const CreateFieldOfStudySuccess = [
  CreateFieldOfStudyResultSchema.pipe(HttpApiSchema.status(200)),
  CreateFieldOfStudyResultSchema.pipe(HttpApiSchema.status(201)),
] as const;

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

/**
 * Representative create-department command payload.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const CreateDepartmentCommandExample = {
  _tag: "CreateDepartment",
  commandId: OrganizationCommandId.make("org-command-0080"),
  departmentId: DepartmentId.make("2"),
  name: "Elektroteknologi",
  shortName: "ELEK",
  email: "elektroteknologi@example.org",
  address: "Sem Sælands vei 11",
  city: "Trondheim",
  latitude: null,
  longitude: null,
  slackChannel: null,
  logoPath: null,
  active: true,
} as const;

/** @since 0.1.0 @category Endpoints */
export const ListDepartmentsEndpoint = HttpApiEndpoint.get("listDepartments", "/api/departments", {
  success: Schema.Array(
    DepartmentJsonSchema.annotate({
      identifier: "DepartmentJson",
      description: "One native department directory row.",
      examples: [DepartmentExample],
    }),
  ),
  error: PublicOrganizationErrors,
}).annotateMerge(
  operationAnnotations("List departments", "Returns the public native department directory."),
);

/** @since 0.1.0 @category Endpoints */
export const ListTeamsEndpoint = HttpApiEndpoint.get("listTeams", "/api/teams", {
  success: Schema.Array(
    TeamJsonSchema.annotate({
      identifier: "TeamJson",
      description: "One native team directory row.",
      examples: [TeamExample],
    }),
  ),
  error: PublicOrganizationErrors,
}).annotateMerge(operationAnnotations("List teams", "Returns the public native team directory."));

export const ListFieldOfStudiesEndpoint = HttpApiEndpoint.get(
  "listFieldOfStudies",
  "/api/field_of_studies",
  {
    success: Schema.Array(
      FieldOfStudyJsonSchema.annotate({
        identifier: "FieldOfStudyJson",
        description: "One native field-of-study directory row.",
        examples: [FieldOfStudyExample],
      }),
    ),
    error: PublicOrganizationErrors,
  },
).annotateMerge(
  operationAnnotations("List fields of study", "Returns the public native study directory."),
);

/** @since 0.1.0 @category Endpoints */
export const ListTeamInterestEndpoint = HttpApiEndpoint.get(
  "listTeamInterest",
  "/api/admin/team-interest",
  { query: OrganizationScopeQuery, success: TeamInterestResponse, error: AdminOrganizationErrors },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "List team interest",
      "Returns registrations within the caller's leader scope.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ListMailingListsEndpoint = HttpApiEndpoint.get(
  "listMailingLists",
  "/api/admin/mailing-lists",
  { query: MailingListQuery, success: MailingListResponse, error: AdminOrganizationErrors },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Project mailing lists",
      "Projects addresses within the caller's leader scope.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const CreateDepartmentEndpoint = HttpApiEndpoint.post(
  "createDepartment",
  "/api/admin/departments",
  {
    payload: CreateDepartmentCommandSchema.annotate({
      identifier: "CreateDepartmentCommand",
      description: "Idempotent create-department command.",
      examples: [CreateDepartmentCommandExample],
    }),
    success: CreateDepartmentSuccess,
    error: AdminOrganizationErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Create department",
      "Creates or replays an idempotent department command.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const CreateTeamEndpoint = HttpApiEndpoint.post("createTeam", "/api/admin/teams", {
  payload: CreateTeamCommandSchema,
  success: CreateTeamSuccess,
  error: AdminOrganizationErrors,
})
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations("Create team", "Creates or replays an idempotent team command."),
  );

/** @since 0.1.0 @category Endpoints */
export const CreateFieldOfStudyEndpoint = HttpApiEndpoint.post(
  "createFieldOfStudy",
  "/api/admin/field-of-studies",
  {
    payload: CreateFieldOfStudyCommandSchema,
    success: CreateFieldOfStudySuccess,
    error: AdminOrganizationErrors,
  },
)
  .middleware(SessionSecurity)
  .annotateMerge(
    operationAnnotations(
      "Create field of study",
      "Creates or replays an idempotent field-of-study command.",
    ),
  );

/**
 * Organization directory and administration API.
 *
 * @since 0.1.0
 * @category Groups
 */
export class OrganizationApi extends HttpApiGroup.make("organization")
  .add(
    ListDepartmentsEndpoint,
    ListTeamsEndpoint,
    ListFieldOfStudiesEndpoint,
    ListTeamInterestEndpoint,
    ListMailingListsEndpoint,
    CreateDepartmentEndpoint,
    CreateTeamEndpoint,
    CreateFieldOfStudyEndpoint,
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Organization",
      description: "Public organization directories and scoped administration.",
      override: { "x-displayName": "Organization" },
    }),
  ) {}
