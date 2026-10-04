/**
 * Schemas, parameters and ordered problem lists of the admission-outcome contract: Rekruttering
 * decides Admitted or Rejected where the interview derives none, the school coordinator announces
 * each outcome once, and the effective outcome message templates are read, previewed and saved.
 * The operations are declared in `admission-outcomes.effx.ts`.
 */
import { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import {
  AdmissionOutcomeCommand,
  AdmissionOutcomeEntry,
  AdmissionOutcomeScope,
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
import { StrongETag, problemUnion } from "./http-semantics.js";

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

/** The empty input of an operation that takes no path, query or body. */
export const EmptyAdmissionOutcomeInput = Schema.Struct({});

/** The application that one outcome operation addresses. */
export const AdmissionOutcomeParams = Schema.Struct({ applicationId: PublicApplicationIdSchema });

/** The variant that one template operation addresses. */
export const OutcomeTemplateKindParams = Schema.Struct({ kind: OutcomeTemplateKind });

/** The department whose override a template operation addresses; absent selects the global default. */
export const OutcomeTemplateScopeQuery = Schema.Struct({
  departmentId: Schema.optional(DepartmentId),
});

/**
 * The ordered problems of the three outcome reads. This list and the two below are the single
 * source of the order: `admission-outcomes-effx-adapters.ts` repeats them as flat literal tuples
 * because the effx frontend cannot resolve a spread of a const tuple, and a test compares each
 * flat tuple with its source element for element.
 */
export const AdmissionOutcomeProblemCodes = [
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
  AdmissionOutcomeProblemCodes,
);

/**
 * A command also answers an unavailable receipt store and the refusals of the outcome policy and
 * of an invalid template, appended after the codes that existed before spec 0027.
 */
export const AdmissionOutcomeCommandProblemCodes = [
  ...AdmissionOutcomeProblemCodes,
  "idempotency.unavailable",
  "admission-outcome.undecided",
  "admission-outcome.placement-active",
  "admission-outcome.final",
  "admission-outcome.derived",
  "admission-outcome.unreviewed",
  "admission-outcome.template-invalid",
] as const;

export const AdmissionOutcomeCommandProblem = problemUnion(
  "AdmissionOutcomeCommandProblem",
  AdmissionOutcomeCommandProblemCodes,
);

/** Reading or previewing a template answers an invalid stored or drafted document; neither writes a receipt. */
export const AdmissionOutcomeTemplateProblemCodes = [
  ...AdmissionOutcomeProblemCodes,
  "admission-outcome.template-invalid",
] as const;

export const AdmissionOutcomeTemplateProblem = problemUnion(
  "AdmissionOutcomeTemplateProblem",
  AdmissionOutcomeTemplateProblemCodes,
);
