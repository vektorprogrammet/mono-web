import { Capability, Concealment, Http, Operation } from "@effx/runtime";
import {
  DepartmentJsonSchema,
  FieldOfStudyJsonSchema,
  TeamJsonSchema,
  AppointmentManagement,
  BoardRosters,
  OrganizationLifecycleCommand,
  OrganizationLifecycleResult,
} from "@vektorprogrammet/domain/organization";
import {
  DelegationCommand,
  DelegationManagement,
  DelegationResult,
} from "@vektorprogrammet/domain/authz";
import { ExternalNativeApi } from "./api.js";
import { PersonSecurity, nativeOperationAnnotations } from "./common.js";
import {
  nativeProblems,
  OrganizationLifecycleCodes,
  OrganizationListDepartmentsCodes,
  OrganizationListTeamsCodes,
  OrganizationListFieldOfStudiesCodes,
  OrganizationListTeamInterestCodes,
  OrganizationListMailingListsCodes,
  OrganizationCreateDepartmentCodes,
  OrganizationCreateTeamCodes,
  OrganizationCreateFieldOfStudyCodes,
} from "./endpoint-problems.js";
import {
  ConditionalReadHeaders,
  IdempotencyHeaders,
  PublicConditionalResponseHeaders,
  PrivateReadResponseHeaders,
  EntityMutationResponseHeaders,
  CreatedMutationResponseHeaders,
} from "./http-semantics.js";
import {
  DepartmentDirectoryResponse,
  TeamDirectoryResponse,
  FieldOfStudyDirectoryResponse,
  OrganizationScopeQuerySchema,
  MailingListQuerySchema,
  TeamInterestResponse,
  MailingListResponse,
  EmptyOrganizationInput,
} from "./organization.js";
import {
  OrganizationAppointmentManagementResolver,
  OrganizationDelegationManagementResolver,
  OrganizationPublicDepartmentsResolver,
  OrganizationPublicTeamsResolver,
  OrganizationPublicFieldOfStudiesResolver,
  OrganizationTeamInterestResolver,
  OrganizationMailingListsResolver,
  OrganizationDepartmentCreateResolver,
  OrganizationTeamCreateResolver,
  OrganizationFieldOfStudyCreateResolver,
  organizationAccessAnnotations,
} from "./organization-effx-adapters.js";
import {
  CreateDepartmentRequest,
  CreateTeamRequest,
  CreateFieldOfStudyRequest,
} from "./v2-schemas.js";

export const OrganizationGroup = Http.group({
  root: ExternalNativeApi,
  group: "organization",
  title: "Organization",
  description: "Public organization directories and scoped administration.",
  displayName: "Organization",
  defaults: {
    metadata: { annotator: nativeOperationAnnotations },
    problems: { registry: nativeProblems },
    access: {
      annotator: organizationAccessAnnotations,
      exposure: "External",
      concealment: Concealment.reveal,
    },
  },
});

export const ReadAppointmentManagement = Operation.query({
  name: "organization.readAppointmentManagement",
  input: EmptyOrganizationInput,
  success: AppointmentManagement,
})
  .in(OrganizationGroup)
  .http.get("/api/organization/appointments")
  .http.contract({
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read appointment management",
      description: "Returns authorized people, units, appointments, account access and history.",
    },
  })
  .http.problems({ identifier: "OrganizationLifecycleProblem", codes: OrganizationLifecycleCodes })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.manage-appointments"),
    requirements: [],
    canonicalScopeResolver: OrganizationAppointmentManagementResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReadBoardRosters = Operation.query({
  name: "organization.readBoardRosters",
  input: EmptyOrganizationInput,
  success: BoardRosters,
})
  .in(OrganizationGroup)
  .http.get("/api/organization/board-rosters")
  .http.contract({
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read board rosters",
      description:
        "Returns the appointed and derived seats of the certificate-issuing boards whose appointments the reader manages, as of the request instant.",
    },
  })
  .http.problems({ identifier: "OrganizationLifecycleProblem", codes: OrganizationLifecycleCodes })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.manage-appointments"),
    requirements: [],
    canonicalScopeResolver: OrganizationAppointmentManagementResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ExecuteLifecycle = Operation.command({
  name: "organization.executeLifecycle",
  input: OrganizationLifecycleCommand,
  success: OrganizationLifecycleResult,
})
  .in(OrganizationGroup)
  .http.post("/api/organization/appointments/commands")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: OrganizationLifecycleCommand,
    status: 200,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Manage appointments and account access",
      description:
        "Applies one authorized, revision-checked lifecycle command with atomic history.",
    },
  })
  .http.problems({ identifier: "OrganizationLifecycleProblem", codes: OrganizationLifecycleCodes })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.manage-appointments"),
    requirements: [],
    canonicalScopeResolver: OrganizationAppointmentManagementResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ReadDelegationManagement = Operation.query({
  name: "organization.readDelegationManagement",
  input: EmptyOrganizationInput,
  success: DelegationManagement,
})
  .in(OrganizationGroup)
  .http.get("/api/organization/delegations")
  .http.contract({
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read delegation management",
      description:
        "Returns the teams, delegations and history within the caller's delegation management reach.",
    },
  })
  .http.problems({ identifier: "OrganizationLifecycleProblem", codes: OrganizationLifecycleCodes })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.manage-delegations"),
    requirements: [],
    canonicalScopeResolver: OrganizationDelegationManagementResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ExecuteDelegation = Operation.command({
  name: "organization.executeDelegation",
  input: DelegationCommand,
  success: DelegationResult,
})
  .in(OrganizationGroup)
  .http.post("/api/organization/delegations/commands")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: DelegationCommand,
    status: 200,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Issue or end a delegation",
      description:
        "Issues or ends one named, time-bounded delegation with atomic history under current authority.",
    },
  })
  .http.problems({ identifier: "OrganizationLifecycleProblem", codes: OrganizationLifecycleCodes })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.manage-delegations"),
    requirements: [],
    canonicalScopeResolver: OrganizationDelegationManagementResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ListDepartments = Operation.query({
  name: "organization.listDepartments",
  input: ConditionalReadHeaders,
  success: DepartmentDirectoryResponse,
})
  .in(OrganizationGroup)
  .http.get("/api/departments")
  .http.contract({
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: PublicConditionalResponseHeaders,
    conditional: true,
    middleware: [],
    metadata: {
      summary: "List departments",
      description: "Returns the public native department directory.",
    },
  })
  .http.problems({
    identifier: "OrganizationListDepartmentsProblem",
    codes: OrganizationListDepartmentsCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: OrganizationPublicDepartmentsResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ListTeams = Operation.query({
  name: "organization.listTeams",
  input: ConditionalReadHeaders,
  success: TeamDirectoryResponse,
})
  .in(OrganizationGroup)
  .http.get("/api/teams")
  .http.contract({
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: PublicConditionalResponseHeaders,
    conditional: true,
    middleware: [],
    metadata: { summary: "List teams", description: "Returns the public native team directory." },
  })
  .http.problems({ identifier: "OrganizationListTeamsProblem", codes: OrganizationListTeamsCodes })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: OrganizationPublicTeamsResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ListFieldOfStudies = Operation.query({
  name: "organization.listFieldOfStudies",
  input: ConditionalReadHeaders,
  success: FieldOfStudyDirectoryResponse,
})
  .in(OrganizationGroup)
  .http.get("/api/field-of-studies")
  .http.contract({
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: PublicConditionalResponseHeaders,
    conditional: true,
    middleware: [],
    metadata: {
      summary: "List fields of study",
      description: "Returns the public native study directory.",
    },
  })
  .http.problems({
    identifier: "OrganizationListFieldOfStudiesProblem",
    codes: OrganizationListFieldOfStudiesCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: OrganizationPublicFieldOfStudiesResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ListTeamInterest = Operation.query({
  name: "organization.listTeamInterest",
  input: OrganizationScopeQuerySchema,
  success: TeamInterestResponse,
})
  .in(OrganizationGroup)
  .http.get("/api/team-interest-registrations")
  .http.contract({
    query: true,
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "List team interest",
      description:
        "Returns registrations within the caller's team-interest reach: the own team for its leader, whole departments for department reach.",
    },
  })
  .http.problems({
    identifier: "OrganizationListTeamInterestProblem",
    codes: OrganizationListTeamInterestCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.read-team-interest"),
    requirements: [],
    canonicalScopeResolver: OrganizationTeamInterestResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ListMailingLists = Operation.query({
  name: "organization.listMailingLists",
  input: MailingListQuerySchema,
  success: MailingListResponse,
})
  .in(OrganizationGroup)
  .http.get("/api/mailing-lists")
  .http.contract({
    query: true,
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Project mailing lists",
      description: "Projects addresses within the departments where the caller reads people.",
    },
  })
  .http.problems({
    identifier: "OrganizationListMailingListsProblem",
    codes: OrganizationListMailingListsCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.read-mailing-lists"),
    requirements: [],
    canonicalScopeResolver: OrganizationMailingListsResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const CreateDepartment = Operation.command({
  name: "organization.createDepartment",
  input: CreateDepartmentRequest,
  success: DepartmentJsonSchema,
})
  .in(OrganizationGroup)
  .http.post("/api/departments")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: CreateDepartmentRequest,
    status: 201,
    responseHeaders: CreatedMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Create department",
      description: "Creates or replays an idempotent department command.",
    },
  })
  .http.problems({
    identifier: "OrganizationCreateDepartmentProblem",
    codes: OrganizationCreateDepartmentCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.create-department"),
    requirements: [],
    canonicalScopeResolver: OrganizationDepartmentCreateResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const CreateTeam = Operation.command({
  name: "organization.createTeam",
  input: CreateTeamRequest,
  success: TeamJsonSchema,
})
  .in(OrganizationGroup)
  .http.post("/api/teams")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: CreateTeamRequest,
    status: 201,
    responseHeaders: CreatedMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Create team",
      description: "Creates or replays an idempotent team command.",
    },
  })
  .http.problems({
    identifier: "OrganizationCreateTeamProblem",
    codes: OrganizationCreateTeamCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.create-team"),
    requirements: [],
    canonicalScopeResolver: OrganizationTeamCreateResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const CreateFieldOfStudy = Operation.command({
  name: "organization.createFieldOfStudy",
  input: CreateFieldOfStudyRequest,
  success: FieldOfStudyJsonSchema,
})
  .in(OrganizationGroup)
  .http.post("/api/field-of-studies")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: CreateFieldOfStudyRequest,
    status: 201,
    responseHeaders: CreatedMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Create field of study",
      description: "Creates or replays an idempotent field-of-study command.",
    },
  })
  .http.problems({
    identifier: "OrganizationCreateFieldOfStudyProblem",
    codes: OrganizationCreateFieldOfStudyCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("organization.create-field-of-study"),
    requirements: [],
    canonicalScopeResolver: OrganizationFieldOfStudyCreateResolver,
    decisionTime: "Transaction",
  })
  .declare();
