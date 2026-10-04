import { Capability, Concealment, Http, Operation } from "@effx/runtime";
import {
  ApplicantProgressResponseSchema,
  PublicApplicationCatalogSchema,
  ReturningAssistantOptionsSchema,
  ReturningAssistantRegistrationResponseSchema,
} from "@vektorprogrammet/domain/application";
import {
  AdmissionPeriodParams,
  EmptyAdmissionsInput,
  PublicApplicationParams,
  ReturningAssistantRegistrationInputSchema,
} from "./admissions.js";
import {
  AdmissionsApplicationCreateResolver,
  AdmissionsManagementPeriodsResolver,
  AdmissionsPeriodByIdResolver,
  AdmissionsPeriodCreateResolver,
  AdmissionsPublicApplicationByIdResolver,
  AdmissionsPublicApplicationOptionsResolver,
  AdmissionsPublicOpenPeriodsResolver,
  admissionsAccessAnnotations,
} from "./admissions-effx-adapters.js";
import { ExternalNativeApi } from "./api.js";
import { nativeOperationAnnotations, PersonSecurity } from "./common.js";
import {
  AdmissionsCreateAdmissionPeriodCodes,
  AdmissionsListAdmissionPeriodsCodes,
  AdmissionsListApplicationOptionsCodes,
  AdmissionsListOpenAdmissionPeriodsCodes,
  AdmissionsReadApplicantProgressCodes,
  AdmissionsReadApplicationConfirmationCodes,
  AdmissionsReadReturningAssistantOptionsCodes,
  AdmissionsRegisterReturningAssistantCodes,
  AdmissionsReviseAdmissionPeriodCodes,
  AdmissionsSubmitApplicationCodes,
  nativeProblems,
} from "./endpoint-problems.js";
import {
  ConditionalReadHeaders,
  CreatedMutationResponseHeaders,
  DynamicAdmissionConditionalResponseHeaders,
  EntityMutationResponseHeaders,
  IdempotencyHeaders,
  IdempotencyIfMatchHeaders,
  NoStoreReadResponseHeaders,
  PrivateReadResponseHeaders,
  ProfileReadResponseHeaders,
} from "./http-semantics.js";
import { ProfileCurrentPerson } from "./profile-effx-adapters.js";
import {
  AdmissionPeriodManagementItem,
  AdmissionPeriodManagementListResponse,
  AdmissionPeriodMergePatch,
  CreateAdmissionPeriodRequest,
  OpenAdmissionPeriodListResponse,
  PublicApplicationConfirmationSchema,
  SubmitApplicationRequest,
} from "./v2-schemas.js";

export const AdmissionsGroup = Http.group({
  root: ExternalNativeApi,
  group: "admissions",
  title: "Admissions",
  description: "Public applicant and administrative admission-period API.",
  defaults: {
    metadata: { annotator: nativeOperationAnnotations },
    problems: { registry: nativeProblems },
    access: {
      annotator: admissionsAccessAnnotations,
      exposure: "External",
      concealment: Concealment.reveal,
    },
  },
});

export const ListOpenAdmissionPeriods = Operation.query({
  name: "admissions.listOpenAdmissionPeriods",
  input: EmptyAdmissionsInput,
  success: OpenAdmissionPeriodListResponse,
})
  .in(AdmissionsGroup)
  .http.get("/api/open-admission-periods")
  .http.contract({
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: DynamicAdmissionConditionalResponseHeaders,
    conditional: true,
    middleware: [],
    metadata: {
      summary: "List open admission periods",
      description: "Returns currently open native admission periods.",
    },
  })
  .http.problems({
    identifier: "AdmissionsListOpenAdmissionPeriodsProblem",
    codes: AdmissionsListOpenAdmissionPeriodsCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: AdmissionsPublicOpenPeriodsResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ListApplicationOptions = Operation.query({
  name: "admissions.listApplicationOptions",
  input: EmptyAdmissionsInput,
  success: PublicApplicationCatalogSchema,
})
  .in(AdmissionsGroup)
  .http.get("/api/application-options")
  .http.contract({
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: DynamicAdmissionConditionalResponseHeaders,
    conditional: true,
    middleware: [],
    metadata: {
      summary: "List application options",
      description: "Returns departments and fields open to applicants.",
    },
  })
  .http.problems({
    identifier: "AdmissionsListApplicationOptionsProblem",
    codes: AdmissionsListApplicationOptionsCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: AdmissionsPublicApplicationOptionsResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const SubmitApplication = Operation.command({
  name: "admissions.submitApplication",
  input: SubmitApplicationRequest,
  success: PublicApplicationConfirmationSchema,
})
  .in(AdmissionsGroup)
  .http.post("/api/applications")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: SubmitApplicationRequest,
    status: 201,
    responseHeaders: CreatedMutationResponseHeaders,
    middleware: [],
    metadata: {
      summary: "Submit application",
      description: "Submits or replays a public applicant command.",
    },
  })
  .http.problems({
    identifier: "AdmissionsSubmitApplicationProblem",
    codes: AdmissionsSubmitApplicationCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: AdmissionsApplicationCreateResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ReadApplicationConfirmation = Operation.query({
  name: "admissions.readApplicationConfirmation",
  input: PublicApplicationParams,
  success: PublicApplicationConfirmationSchema,
})
  .in(AdmissionsGroup)
  .http.get("/api/applications/:applicationId")
  .http.contract({
    params: PublicApplicationParams,
    status: 200,
    responseHeaders: NoStoreReadResponseHeaders,
    middleware: [],
    metadata: {
      summary: "Read application confirmation",
      description: "Returns the public confirmation projection.",
    },
  })
  .http.problems({
    identifier: "AdmissionsReadApplicationConfirmationProblem",
    codes: AdmissionsReadApplicationConfirmationCodes,
  })
  .http.access({
    acceptedCredentials: ["None"],
    principalKinds: ["Anonymous"],
    capabilities: Capability.none,
    requirements: [],
    canonicalScopeResolver: AdmissionsPublicApplicationByIdResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReadApplicantProgress = Operation.query({
  name: "admissions.readApplicantProgress",
  input: EmptyAdmissionsInput,
  success: ApplicantProgressResponseSchema,
})
  .in(AdmissionsGroup)
  .http.get("/api/applicant-progress")
  .http.contract({
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read applicant progress",
      description: "Returns current-semester recruitment progress for the signed-in applicant.",
    },
  })
  .http.problems({
    identifier: "AdmissionsReadApplicantProgressProblem",
    codes: AdmissionsReadApplicantProgressCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("admissions.read-applicant-progress"),
    requirements: [{ id: "profile.owner" }],
    canonicalScopeResolver: ProfileCurrentPerson,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ListAdmissionPeriods = Operation.query({
  name: "admissions.listAdmissionPeriods",
  input: EmptyAdmissionsInput,
  success: AdmissionPeriodManagementListResponse,
})
  .in(AdmissionsGroup)
  .http.get("/api/admission-periods")
  .http.contract({
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: ProfileReadResponseHeaders,
    conditional: true,
    middleware: [PersonSecurity],
    metadata: {
      summary: "List admission periods",
      description: "Returns the management admission-period projection.",
    },
  })
  .http.problems({
    identifier: "AdmissionsListAdmissionPeriodsProblem",
    codes: AdmissionsListAdmissionPeriodsCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("admissions.read-periods"),
    requirements: [],
    canonicalScopeResolver: AdmissionsManagementPeriodsResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const CreateAdmissionPeriod = Operation.command({
  name: "admissions.createAdmissionPeriod",
  input: CreateAdmissionPeriodRequest,
  success: AdmissionPeriodManagementItem,
})
  .in(AdmissionsGroup)
  .http.post("/api/admission-periods")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: CreateAdmissionPeriodRequest,
    status: 201,
    responseHeaders: CreatedMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Create admission period",
      description: "Creates or replays an admission-period command.",
    },
  })
  .http.problems({
    identifier: "AdmissionsCreateAdmissionPeriodProblem",
    codes: AdmissionsCreateAdmissionPeriodCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("admissions.create-period"),
    requirements: [],
    canonicalScopeResolver: AdmissionsPeriodCreateResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ReviseAdmissionPeriod = Operation.command({
  name: "admissions.reviseAdmissionPeriod",
  input: AdmissionPeriodMergePatch,
  success: AdmissionPeriodManagementItem,
})
  .in(AdmissionsGroup)
  .http.patch("/api/admission-periods/:admissionPeriodId")
  .http.contract({
    params: AdmissionPeriodParams,
    headers: IdempotencyIfMatchHeaders,
    payload: AdmissionPeriodMergePatch,
    mediaType: "application/merge-patch+json",
    status: 200,
    responseHeaders: EntityMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Revise admission period",
      description: "Revises or replays an admission-period command.",
    },
  })
  .http.problems({
    identifier: "AdmissionsReviseAdmissionPeriodProblem",
    codes: AdmissionsReviseAdmissionPeriodCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("admissions.revise-period"),
    requirements: [],
    canonicalScopeResolver: AdmissionsPeriodByIdResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ReadReturningAssistantOptions = Operation.query({
  name: "admissions.readReturningAssistantOptions",
  input: EmptyAdmissionsInput,
  success: ReturningAssistantOptionsSchema,
})
  .in(AdmissionsGroup)
  .http.get("/api/returning-assistant/options")
  .http.contract({
    status: 200,
    responseHeaders: NoStoreReadResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Read returning-assistant registration options",
      description: "Returns current identity, placement, department and admission-period options.",
    },
  })
  .http.problems({
    identifier: "AdmissionsReadReturningAssistantOptionsProblem",
    codes: AdmissionsReadReturningAssistantOptionsCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("placements.self"),
    requirements: [],
    canonicalScopeResolver: ProfileCurrentPerson,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const RegisterReturningAssistant = Operation.command({
  name: "admissions.registerReturningAssistant",
  input: ReturningAssistantRegistrationInputSchema,
  success: ReturningAssistantRegistrationResponseSchema,
})
  .in(AdmissionsGroup)
  .http.post("/api/returning-assistant/registrations")
  .http.contract({
    headers: IdempotencyHeaders,
    payload: ReturningAssistantRegistrationInputSchema,
    status: 201,
    responseHeaders: CreatedMutationResponseHeaders,
    middleware: [PersonSecurity],
    metadata: {
      summary: "Register returning assistant",
      description:
        "Registers a returning assistant for an admission period with immutable provenance.",
    },
  })
  .http.problems({
    identifier: "AdmissionsRegisterReturningAssistantProblem",
    codes: AdmissionsRegisterReturningAssistantCodes,
  })
  .http.access({
    acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
    principalKinds: ["Person"],
    capabilities: Capability.one("placements.self"),
    requirements: [],
    canonicalScopeResolver: ProfileCurrentPerson,
    decisionTime: "Transaction",
  })
  .declare();
