import { Capability, Concealment, Http, Operation } from "@effx/runtime";
import { AdmissionOutcomeScopes } from "@vektorprogrammet/domain/admissions";
import {
  AdmissionOutcomeAnnounceCommand,
  AdmissionOutcomeAnnounceResource,
  AdmissionOutcomeBoardResource,
  AdmissionOutcomeCommand,
  AdmissionOutcomeParams,
  AdmissionOutcomeResource,
  AdmissionOutcomeScope,
  EmptyAdmissionOutcomeInput,
  OutcomeTemplateDraft,
  OutcomeTemplateKindParams,
  OutcomeTemplatePreviewRequest,
  OutcomeTemplateResource,
  OutcomeTemplateScopeQuery,
  RenderedOutcomeMail,
} from "./admission-outcomes.js";
import {
  AdmissionOutcomeCommandCodes,
  AdmissionOutcomeReadCodes,
  AdmissionOutcomesAnnouncementResolver,
  AdmissionOutcomesApplicationOutcomesResolver,
  AdmissionOutcomesTemplatesResolver,
  admissionOutcomesAccessAnnotations,
  AdmissionOutcomeTemplateCodes,
} from "./admission-outcomes-effx-adapters.js";
import { ExternalNativeApi } from "./api.js";
import { nativeOperationAnnotations, PersonSecurity } from "./common.js";
import { nativeProblems } from "./endpoint-problems.js";
import {
  ConditionalReadHeaders,
  EntityMutationResponseHeaders,
  IdempotencyIfMatchHeaders,
  PrivateEntityMutationResponseHeaders,
  PrivateReadResponseHeaders,
  ProfileReadResponseHeaders,
} from "./http-semantics.js";

export const AdmissionOutcomesGroup = Http.group({
  root: ExternalNativeApi,
  group: "admissionOutcomes",
  title: "Admission outcomes",
  description:
    "Admission outcomes, their one-time announcement and the editable outcome message templates.",
  defaults: {
    middleware: [PersonSecurity],
    metadata: { annotator: nativeOperationAnnotations },
    problems: { registry: nativeProblems },
    access: {
      annotator: admissionOutcomesAccessAnnotations,
      exposure: "External",
      acceptedCredentials: ["BetterAuthCookie", "OAuthUserBearer"],
      principalKinds: ["Person"],
      concealment: Concealment.reveal,
    },
  },
});

export const ListScopes = Operation.query({
  name: "admissionOutcomes.listScopes",
  input: EmptyAdmissionOutcomeInput,
  success: AdmissionOutcomeScopes,
})
  .in(AdmissionOutcomesGroup)
  .http.get("/api/admission-outcomes/scopes")
  .http.contract({
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    metadata: {
      summary: "Select admission outcome scope",
      description: "Authorized departments and canonical historical semesters.",
    },
  })
  .http.problems({
    identifier: "AdmissionOutcomeProblem",
    codes: AdmissionOutcomeReadCodes,
  })
  .http.access({
    capabilities: Capability.any("admissions.outcomes.read", "admissions.outcomes.announce"),
    requirements: [],
    canonicalScopeResolver: AdmissionOutcomesApplicationOutcomesResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReadOutcomes = Operation.query({
  name: "admissionOutcomes.readOutcomes",
  input: AdmissionOutcomeScope,
  success: AdmissionOutcomeBoardResource,
})
  .in(AdmissionOutcomesGroup)
  .http.get("/api/admission-outcomes")
  .http.contract({
    query: true,
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    metadata: {
      summary: "Read admission outcomes",
      description:
        "Admission management reads every application of the period. The school coordinator reads each application's name, lifecycle state and ETag, never the applicant's contact data.",
    },
  })
  .http.problems({
    identifier: "AdmissionOutcomeProblem",
    codes: AdmissionOutcomeReadCodes,
  })
  .http.access({
    capabilities: Capability.any("admissions.outcomes.read", "admissions.outcomes.announce"),
    requirements: [],
    canonicalScopeResolver: AdmissionOutcomesApplicationOutcomesResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const ReadOutcome = Operation.query({
  name: "admissionOutcomes.readOutcome",
  input: AdmissionOutcomeParams,
  success: AdmissionOutcomeResource,
})
  .in(AdmissionOutcomesGroup)
  .http.get("/api/admission-outcomes/:applicationId")
  .http.contract({
    params: AdmissionOutcomeParams,
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: ProfileReadResponseHeaders,
    conditional: true,
    metadata: {
      summary: "Select admission outcome",
      description: "Only admission management reads one application's outcome entry.",
    },
  })
  .http.problems({
    identifier: "AdmissionOutcomeProblem",
    codes: AdmissionOutcomeReadCodes,
  })
  .http.access({
    capabilities: Capability.one("admissions.outcomes.read"),
    requirements: [],
    canonicalScopeResolver: AdmissionOutcomesApplicationOutcomesResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const DecideOutcome = Operation.command({
  name: "admissionOutcomes.decideOutcome",
  input: AdmissionOutcomeCommand,
  success: AdmissionOutcomeResource,
})
  .in(AdmissionOutcomesGroup)
  .http.post("/api/admission-outcomes/:applicationId:decide")
  .http.contract({
    params: AdmissionOutcomeParams,
    headers: IdempotencyIfMatchHeaders,
    payload: AdmissionOutcomeCommand,
    status: 200,
    responseHeaders: EntityMutationResponseHeaders,
    metadata: {
      summary: "Decide admission outcome",
      description:
        "Rekruttering decides Admitted or Rejected for a Kanskje or returning application. An interview's Ja or Nei derives its outcome and cannot be decided. Deciding the current decision again changes nothing, and nothing is announced.",
    },
  })
  .http.problems({
    identifier: "AdmissionOutcomeCommandProblem",
    codes: AdmissionOutcomeCommandCodes,
  })
  .http.access({
    capabilities: Capability.one("admissions.outcomes.decide"),
    requirements: [],
    canonicalScopeResolver: AdmissionOutcomesApplicationOutcomesResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const AnnounceOutcome = Operation.command({
  name: "admissionOutcomes.announceOutcome",
  input: AdmissionOutcomeAnnounceCommand,
  success: AdmissionOutcomeAnnounceResource,
})
  .in(AdmissionOutcomesGroup)
  .http.post("/api/admission-outcomes/:applicationId:announce")
  .http.contract({
    params: AdmissionOutcomeParams,
    headers: IdempotencyIfMatchHeaders,
    payload: AdmissionOutcomeAnnounceCommand,
    status: 200,
    responseHeaders: PrivateEntityMutationResponseHeaders,
    metadata: {
      summary: "Announce admission outcome",
      description:
        "The school coordinator of the application's department announces its outcome once: the server derives it, stores it as final and queues one mail from the effective template.",
    },
  })
  .http.problems({
    identifier: "AdmissionOutcomeCommandProblem",
    codes: AdmissionOutcomeCommandCodes,
  })
  .http.access({
    capabilities: Capability.one("admissions.outcomes.announce"),
    requirements: [{ id: "admissions.department-coordinator" }],
    canonicalScopeResolver: AdmissionOutcomesAnnouncementResolver,
    decisionTime: "Transaction",
  })
  .declare();

export const ReadOutcomeTemplates = Operation.query({
  name: "admissionOutcomes.readOutcomeTemplates",
  input: OutcomeTemplateScopeQuery,
  success: OutcomeTemplateResource,
})
  .in(AdmissionOutcomesGroup)
  .http.get("/api/admission-outcomes/templates")
  .http.contract({
    query: true,
    headers: ConditionalReadHeaders,
    status: 200,
    responseHeaders: ProfileReadResponseHeaders,
    conditional: true,
    metadata: {
      summary: "Read outcome message templates",
      description:
        "The effective Admitted and Rejected variants of the global default, or of one department with the provenance of each variant. Only the department's coordinator or a global administrator reads them.",
    },
  })
  .http.problems({
    identifier: "AdmissionOutcomeTemplateProblem",
    codes: AdmissionOutcomeTemplateCodes,
  })
  .http.access({
    capabilities: Capability.one("admissions.outcome-templates.read"),
    requirements: [],
    canonicalScopeResolver: AdmissionOutcomesTemplatesResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

/** A Query over POST: it reads and writes no receipt, and its private draft stays out of the URL. */
export const PreviewOutcomeTemplate = Operation.query({
  name: "admissionOutcomes.previewOutcomeTemplate",
  input: OutcomeTemplatePreviewRequest,
  success: RenderedOutcomeMail,
})
  .in(AdmissionOutcomesGroup)
  .http.post("/api/admission-outcomes/templates/:kind:preview")
  .http.contract({
    params: OutcomeTemplateKindParams,
    query: OutcomeTemplateScopeQuery,
    payload: OutcomeTemplatePreviewRequest,
    payloadIsQuery: true,
    status: 200,
    responseHeaders: PrivateReadResponseHeaders,
    metadata: {
      summary: "Preview outcome message template",
      description:
        "Validates a draft with the schema of save and announce and answers the exact subject, HTML and text that the server would send for the sample values. Nothing is stored.",
    },
  })
  .http.problems({
    identifier: "AdmissionOutcomeTemplateProblem",
    codes: AdmissionOutcomeTemplateCodes,
  })
  .http.access({
    capabilities: Capability.one("admissions.outcome-templates.edit"),
    requirements: [],
    canonicalScopeResolver: AdmissionOutcomesTemplatesResolver,
    decisionTime: "SnapshotRead",
  })
  .declare();

export const SaveOutcomeTemplate = Operation.command({
  name: "admissionOutcomes.saveOutcomeTemplate",
  input: OutcomeTemplateDraft,
  success: OutcomeTemplateResource,
})
  .in(AdmissionOutcomesGroup)
  .http.put("/api/admission-outcomes/templates/:kind")
  .http.contract({
    params: OutcomeTemplateKindParams,
    query: OutcomeTemplateScopeQuery,
    headers: IdempotencyIfMatchHeaders,
    payload: OutcomeTemplateDraft,
    status: 200,
    responseHeaders: EntityMutationResponseHeaders,
    metadata: {
      summary: "Save outcome message template",
      description:
        "Appends one revision of a variant for the global default or one department's override. Only a global administrator saves a default, and only the department's delegated school coordinator saves its override. A queued mail never changes.",
    },
  })
  .http.problems({
    identifier: "AdmissionOutcomeCommandProblem",
    codes: AdmissionOutcomeCommandCodes,
  })
  .http.access({
    capabilities: Capability.one("admissions.outcome-templates.edit"),
    requirements: [],
    canonicalScopeResolver: AdmissionOutcomesTemplatesResolver,
    decisionTime: "Transaction",
  })
  .declare();
