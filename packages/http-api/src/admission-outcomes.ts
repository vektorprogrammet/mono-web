/**
 * HTTP contract for admission outcomes: Rekruttering decides Admitted or Rejected where the
 * interview derives none, the school coordinator announces each outcome once, and the effective
 * outcome message templates are read, previewed and saved.
 */
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import {
  AdmissionOutcomeCommand,
  AdmissionOutcomeEntry,
  AdmissionOutcomeScope,
  AdmissionOutcomeScopes,
} from "@vektorprogrammet/domain/admissions";
import {
  OutcomeMailValues,
  OutcomeTemplateDraft,
  OutcomeTemplateKind,
  OutcomeTemplateSet,
  RenderedOutcomeMail,
} from "@vektorprogrammet/domain/admissions/template";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, personNativeAccess } from "./access.js";
import { operationAnnotations, PersonSecurity } from "./common.js";
import {
  ConditionalReadHeaders,
  StrongETag,
  IdempotencyIfMatchHeaders,
  privateReadResponse,
  privateConditionalResponses,
  entityMutationResponse,
  privateEntityMutationResponse,
  endpointProblemResponses,
  problemUnion,
} from "./http-semantics.js";

export { AdmissionOutcomeCommand, AdmissionOutcomeScope };

/** What Rekruttering sees of an application: every entry field, with its current ETag. */
export const AdmissionOutcomeResource = Schema.Struct({
  ...AdmissionOutcomeEntry.fields,
  etag: StrongETag,
}).annotate({ identifier: "AdmissionOutcomeResource" });

/**
 * What the school coordinator sees of an application: no recipient, phone or study data, only
 * what announcing needs. `state` shows whether the outcome is final, and a null `outcome` shows
 * that Rekruttering has not decided yet.
 */
export const AdmissionOutcomeAnnounceResource = Schema.Struct({
  applicationId: AdmissionOutcomeEntry.fields.applicationId,
  firstName: AdmissionOutcomeEntry.fields.firstName,
  lastName: AdmissionOutcomeEntry.fields.lastName,
  state: AdmissionOutcomeEntry.fields.state,
  outcome: AdmissionOutcomeEntry.fields.outcome,
  placed: AdmissionOutcomeEntry.fields.placed,
  etag: StrongETag,
}).annotate({ identifier: "AdmissionOutcomeAnnounceResource" });

/** The empty command of an announcement: the server derives the outcome and the message. */
export const AdmissionOutcomeAnnounceCommand = Schema.Struct({}).annotate({
  identifier: "AdmissionOutcomeAnnounceCommand",
});

const BoardFields = {
  ...AdmissionOutcomeScope.fields,
  admissionPeriodId: Schema.NullOr(AdmissionPeriodId),
};

/**
 * Rekruttering and administrators see every application (`Decide`, with `canAnnounce` for the
 * administrator who may also announce); the school coordinator sees the minimal `Announce`
 * projection. A plain department member sees nothing.
 */
export const AdmissionOutcomeBoardResource = Schema.TaggedUnion({
  Decide: {
    ...BoardFields,
    canAnnounce: Schema.Boolean,
    entries: Schema.Array(AdmissionOutcomeResource),
  },
  Announce: { ...BoardFields, entries: Schema.Array(AdmissionOutcomeAnnounceResource) },
}).annotate({ identifier: "AdmissionOutcomeBoardResource" });

/** The effective template variants of one scope and the ETag of that set. */
export const OutcomeTemplateResource = Schema.Struct({
  ...OutcomeTemplateSet.fields,
  etag: StrongETag,
}).annotate({ identifier: "OutcomeTemplateResource" });

/** A draft and the synthetic values that fill its placeholders for a preview. */
export const OutcomeTemplatePreviewRequest = Schema.Struct({
  ...OutcomeTemplateDraft.fields,
  sample: OutcomeMailValues,
}).annotate({ identifier: "OutcomeTemplatePreviewRequest" });

export { OutcomeTemplateDraft, OutcomeTemplateKind, RenderedOutcomeMail };

const admissionOutcomeProblems = [
  "request.malformed",
  "request.too-large",
  "precondition.invalid",
  "idempotency-key.invalid",
  "header.malformed",
  "validation.failed",
  "scope.invalid",
  "authority.denied",
  "resource.not-found",
  "precondition.required",
  "precondition.failed",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "internal.error",
  "media-type.unsupported",
] as const;

export const AdmissionOutcomeProblem = problemUnion(
  "AdmissionOutcomeProblem",
  admissionOutcomeProblems,
);

/**
 * A command also answers an unavailable receipt store and the refusals of the outcome policy and
 * of an invalid template, appended after the codes that existed before spec 0027.
 */
export const AdmissionOutcomeCommandProblem = problemUnion("AdmissionOutcomeCommandProblem", [
  ...admissionOutcomeProblems,
  "idempotency.unavailable",
  "admission-outcome.undecided",
  "admission-outcome.placement-active",
  "admission-outcome.final",
  "admission-outcome.derived",
  "admission-outcome.unreviewed",
  "admission-outcome.template-invalid",
]);

/** Reading or previewing a template answers an invalid stored or drafted document; neither writes a receipt. */
export const AdmissionOutcomeTemplateProblem = problemUnion("AdmissionOutcomeTemplateProblem", [
  ...admissionOutcomeProblems,
  "admission-outcome.template-invalid",
]);

const access = (
  capability: "admissions.outcomes.read" | "admissions.outcomes.decide",
  decisionTime: "SnapshotRead" | "Transaction",
) =>
  personNativeAccess({
    capability,
    canonicalScopeResolver: "admissions.application-outcomes",
    decisionTime,
  });

/** Announcing needs the capability and the coordinator of the application's department, in the committing transaction. */
const announceAccess = personNativeAccess({
  capability: "admissions.outcomes.announce",
  canonicalScopeResolver: "admissions.outcome-announcement",
  requirements: ["admissions.department-coordinator"],
  decisionTime: "Transaction",
});

/** The coordinator reads the board and the scopes through the same operations as the decider. */
const readAccess = personNativeAccess({
  capability: "admissions.outcomes.read",
  alternatives: ["admissions.outcomes.announce"],
  canonicalScopeResolver: "admissions.application-outcomes",
  decisionTime: "SnapshotRead",
});

const templateAccess = (
  capability: "admissions.outcome-templates.read" | "admissions.outcome-templates.edit",
  decisionTime: "SnapshotRead" | "Transaction",
) =>
  personNativeAccess({
    capability,
    canonicalScopeResolver: "admissions.outcome-templates",
    decisionTime,
  });

export const ListAdmissionOutcomeScopesEndpoint = HttpApiEndpoint.get(
  "listScopes",
  "/api/admission-outcomes/scopes",
  {
    success: privateReadResponse(AdmissionOutcomeScopes),
    error: endpointProblemResponses(AdmissionOutcomeProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, readAccess))
  .annotateMerge(
    operationAnnotations(
      "Select admission outcome scope",
      "Authorized departments and canonical historical semesters.",
    ),
  );

export const ReadAdmissionOutcomesEndpoint = HttpApiEndpoint.get(
  "readOutcomes",
  "/api/admission-outcomes",
  {
    query: AdmissionOutcomeScope.fields,
    success: privateReadResponse(AdmissionOutcomeBoardResource),
    error: endpointProblemResponses(AdmissionOutcomeProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, readAccess))
  .annotateMerge(
    operationAnnotations(
      "Read admission outcomes",
      "Admission management reads every application of the period. The school coordinator reads each application's name, lifecycle state and ETag, never the applicant's contact data.",
    ),
  );

export const ReadAdmissionOutcomeEndpoint = HttpApiEndpoint.get(
  "readOutcome",
  "/api/admission-outcomes/:applicationId",
  {
    params: { applicationId: PublicApplicationIdSchema },
    headers: ConditionalReadHeaders,
    success: privateConditionalResponses(AdmissionOutcomeResource),
    error: endpointProblemResponses(AdmissionOutcomeProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("admissions.outcomes.read", "SnapshotRead")))
  .annotateMerge(
    operationAnnotations(
      "Select admission outcome",
      "Only admission management reads one application's outcome entry.",
    ),
  );

export const DecideAdmissionOutcomeEndpoint = HttpApiEndpoint.post(
  "decideOutcome",
  "/api/admission-outcomes/:applicationId:decide",
  {
    params: { applicationId: PublicApplicationIdSchema },
    headers: IdempotencyIfMatchHeaders,
    payload: AdmissionOutcomeCommand,
    success: entityMutationResponse(AdmissionOutcomeResource),
    error: endpointProblemResponses(AdmissionOutcomeCommandProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, access("admissions.outcomes.decide", "Transaction")))
  .annotateMerge(
    operationAnnotations(
      "Decide admission outcome",
      "Rekruttering decides Admitted or Rejected for a Kanskje or returning application. An interview's Ja or Nei derives its outcome and cannot be decided. Deciding the current decision again changes nothing, and nothing is announced.",
    ),
  );

export const AnnounceAdmissionOutcomeEndpoint = HttpApiEndpoint.post(
  "announceOutcome",
  "/api/admission-outcomes/:applicationId:announce",
  {
    params: { applicationId: PublicApplicationIdSchema },
    headers: IdempotencyIfMatchHeaders,
    payload: AdmissionOutcomeAnnounceCommand,
    success: privateEntityMutationResponse(AdmissionOutcomeAnnounceResource),
    error: endpointProblemResponses(AdmissionOutcomeCommandProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) => annotateAccessSpec(e, announceAccess))
  .annotateMerge(
    operationAnnotations(
      "Announce admission outcome",
      "The school coordinator of the application's department announces its outcome once: the server derives it, stores it as final and queues one mail from the effective template.",
    ),
  );

export const ReadOutcomeTemplatesEndpoint = HttpApiEndpoint.get(
  "readOutcomeTemplates",
  "/api/admission-outcomes/templates",
  {
    query: { departmentId: Schema.optional(DepartmentId) },
    headers: ConditionalReadHeaders,
    success: privateConditionalResponses(OutcomeTemplateResource),
    error: endpointProblemResponses(AdmissionOutcomeTemplateProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) =>
    annotateAccessSpec(e, templateAccess("admissions.outcome-templates.read", "SnapshotRead")),
  )
  .annotateMerge(
    operationAnnotations(
      "Read outcome message templates",
      "The effective Admitted and Rejected variants of the global default, or of one department with the provenance of each variant. Only the department's coordinator or a global administrator reads them.",
    ),
  );

export const PreviewOutcomeTemplateEndpoint = HttpApiEndpoint.post(
  "previewOutcomeTemplate",
  "/api/admission-outcomes/templates/:kind:preview",
  {
    params: { kind: OutcomeTemplateKind },
    query: { departmentId: Schema.optional(DepartmentId) },
    payload: OutcomeTemplatePreviewRequest,
    success: privateReadResponse(RenderedOutcomeMail),
    error: endpointProblemResponses(AdmissionOutcomeTemplateProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) =>
    annotateAccessSpec(e, templateAccess("admissions.outcome-templates.edit", "SnapshotRead")),
  )
  .annotateMerge(
    operationAnnotations(
      "Preview outcome message template",
      "Validates a draft with the schema of save and announce and answers the exact subject, HTML and text that the server would send for the sample values. Nothing is stored.",
    ),
  );

export const SaveOutcomeTemplateEndpoint = HttpApiEndpoint.put(
  "saveOutcomeTemplate",
  "/api/admission-outcomes/templates/:kind",
  {
    params: { kind: OutcomeTemplateKind },
    query: { departmentId: Schema.optional(DepartmentId) },
    headers: IdempotencyIfMatchHeaders,
    payload: OutcomeTemplateDraft,
    success: entityMutationResponse(OutcomeTemplateResource),
    error: endpointProblemResponses(AdmissionOutcomeCommandProblem),
  },
)
  .middleware(PersonSecurity)
  .pipe((e) =>
    annotateAccessSpec(e, templateAccess("admissions.outcome-templates.edit", "Transaction")),
  )
  .annotateMerge(
    operationAnnotations(
      "Save outcome message template",
      "Appends one revision of a variant for the global default or one department's override. Only a global administrator saves a default, and only the department's delegated school coordinator saves its override. A queued mail never changes.",
    ),
  );

export class AdmissionOutcomesApi extends HttpApiGroup.make("admissionOutcomes")
  .add(ListAdmissionOutcomeScopesEndpoint)
  .add(ReadAdmissionOutcomesEndpoint)
  .add(ReadAdmissionOutcomeEndpoint)
  .add(DecideAdmissionOutcomeEndpoint)
  .add(AnnounceAdmissionOutcomeEndpoint)
  .add(ReadOutcomeTemplatesEndpoint)
  .add(PreviewOutcomeTemplateEndpoint)
  .add(SaveOutcomeTemplateEndpoint)
  .annotateMerge(
    OpenApi.annotations({
      title: "Admission outcomes",
      description:
        "Admission outcomes, their one-time announcement and the editable outcome message templates.",
    }),
  ) {}
