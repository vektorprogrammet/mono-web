/**
 * Days served and certificates: school coordination confirms each assistant's days served per
 * department and semester, and an issuer downloads the cumulative certificate of an assistant.
 *
 * Each RPC keeps the operation ID of the HTTP operation it replaces as its tag. A read takes the
 * old path and query members as its payload; a command adds its `idempotencyKey` and the `ifMatch`
 * of the entry or certificate it acts on. The issued certificate is the PDF's bytes.
 *
 * @since 0.3.0
 */
import { DepartmentId, PersonId, SemesterId } from "@vektorprogrammet/domain/organization";
import {
  AssistantCursor,
  CertificateAssistant,
  CertificatePreview,
  CertificateScopes,
  CertificateSemesterScope,
  DAYS_SERVED_PAGE_SIZE,
  DaysServedEntry,
  DaysServedTotal,
} from "@vektorprogrammet/domain/placements";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { personNativeAccess, withAccessSpec } from "./access.js";
import { PersonCredential } from "./credential.js";
import { IdempotencyKey, problemUnion, rpcProblems, StrongETag } from "./problem.js";

export { AssistantCursor, CertificateScopes, DaysServedTotal };

/** One assistant's days served, with the entity tag that a confirmation's `ifMatch` repeats. */
export const DaysServedEntryResource = Schema.Struct({
  ...DaysServedEntry.fields,
  etag: StrongETag,
}).annotate({
  identifier: "DaysServedEntryResource",
  description:
    "One assistant in one department and semester: the dated evidence, the calculated count, and the current confirmation.",
});

export const DaysServedListResponse = Schema.Struct({
  departmentId: DepartmentId,
  departmentName: Schema.String,
  semester: CertificateSemesterScope,
  items: Schema.Array(DaysServedEntryResource).pipe(
    Schema.check(Schema.isMaxLength(DAYS_SERVED_PAGE_SIZE)),
  ),
  nextCursor: Schema.optional(AssistantCursor),
}).annotate({
  identifier: "DaysServedListResponse",
  description: `One page of at most ${DAYS_SERVED_PAGE_SIZE} assistants, ordered by name.`,
});

/** Confirms the calculated count, or adjusts it; zero is a confirmed total too. */
export const ConfirmDaysServedInput = Schema.Struct({ total: DaysServedTotal }).annotate({
  identifier: "ConfirmDaysServedInput",
});

export const CertificateListResponse = Schema.Struct({
  departmentId: DepartmentId,
  departmentName: Schema.String,
  items: Schema.Array(CertificateAssistant).pipe(
    Schema.check(Schema.isMaxLength(DAYS_SERVED_PAGE_SIZE)),
  ),
  nextCursor: Schema.optional(AssistantCursor),
}).annotate({
  identifier: "CertificateListResponse",
  description: `One page of at most ${DAYS_SERVED_PAGE_SIZE} assistants with service in the department, ordered by name.`,
});

/** What the issuer sees before download, with the entity tag of the content that would be issued. */
export const CertificatePreviewResource = Schema.Struct({
  ...CertificatePreview.fields,
  etag: StrongETag,
}).annotate({
  identifier: "CertificatePreviewResource",
  description:
    "Every semester of the assistant in the department with its status, the certificate that an issue would record, and its content entity tag.",
});

/** The bytes of one issued certificate, an `application/pdf` document. */
export const CertificatePdf = Schema.Uint8Array.annotate({
  identifier: "CertificatePdf",
  description: "The PDF of the recorded certificate issue.",
});

export const CertificatesReadProblem = problemUnion("CertificatesReadProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "transaction.conflict",
  "internal.error",
]);

/** A list also answers a cursor that the page it names cannot resolve. */
export const CertificatesListProblem = problemUnion("CertificatesListProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "request.malformed",
  "transaction.conflict",
  "internal.error",
]);

export const CertificatesConfirmProblem = problemUnion("CertificatesConfirmProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "precondition.failed",
  "internal.error",
  "idempotency.unavailable",
]);

export const CertificatesIssueProblem = problemUnion("CertificatesIssueProblem", [
  "credential.missing",
  "credential.invalid",
  "authority.denied",
  "resource.not-found",
  "idempotency.in-flight",
  "idempotency.digest-conflict",
  "idempotency.response-expired",
  "transaction.conflict",
  "precondition.failed",
  "certificate.empty",
  "certificate.unprintable",
  "internal.error",
  "idempotency.unavailable",
]);

const access = (
  capability: "placements.days-served" | "certificates.issue",
  decisionTime: "SnapshotRead" | "Transaction",
) =>
  withAccessSpec(
    personNativeAccess({
      capability,
      canonicalScopeResolver: "placements.explicit-department",
      decisionTime,
    }),
  );

/**
 * The departments where the reader confirms days served or issues certificates, and the
 * semesters. Either capability in some department grants the read.
 */
export const ReadCertificateScopes = Rpc.make("certificates.readCertificateScopes", {
  success: CertificateScopes,
  error: rpcProblems(CertificatesReadProblem),
})
  .middleware(PersonCredential)
  .pipe(
    withAccessSpec(
      personNativeAccess({
        capability: "placements.days-served",
        alternatives: ["certificates.issue"],
        canonicalScopeResolver: "placements.explicit-department",
        decisionTime: "SnapshotRead",
      }),
    ),
  );

/**
 * A bounded page of the assistants of a department and semester with the dated evidence, the
 * calculated count, and the current confirmation. Requires the days-served capability in the
 * department.
 */
export const ListDaysServed = Rpc.make("certificates.listDaysServed", {
  payload: Schema.Struct({
    departmentId: DepartmentId,
    semesterId: SemesterId,
    cursor: Schema.optional(AssistantCursor),
  }),
  success: DaysServedListResponse,
  error: rpcProblems(CertificatesListProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.days-served", "SnapshotRead"));

/**
 * Confirms or adjusts one assistant's total for the semester as the next revision. The earlier
 * confirmation stays as history. Requires the observed entry entity tag.
 */
export const ConfirmDaysServed = Rpc.make("certificates.confirmDaysServed", {
  payload: Schema.Struct({
    departmentId: DepartmentId,
    semesterId: SemesterId,
    personId: PersonId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
    request: ConfirmDaysServedInput,
  }),
  success: DaysServedEntryResource,
  error: rpcProblems(CertificatesConfirmProblem),
})
  .middleware(PersonCredential)
  .pipe(access("placements.days-served", "Transaction"));

/**
 * A bounded page of the assistants with service in the department and how many semesters their
 * certificate lists. Issuers of the department only.
 */
export const ListCertificates = Rpc.make("certificates.listCertificates", {
  payload: Schema.Struct({
    departmentId: DepartmentId,
    cursor: Schema.optional(AssistantCursor),
  }),
  success: CertificateListResponse,
  error: rpcProblems(CertificatesListProblem),
})
  .middleware(PersonCredential)
  .pipe(access("certificates.issue", "SnapshotRead"));

/**
 * Every semester of the assistant in the department with its status and the certificate that an
 * issue would record. Issuers of the department only, never the assistant.
 */
export const ReadCertificate = Rpc.make("certificates.readCertificate", {
  payload: Schema.Struct({ departmentId: DepartmentId, personId: PersonId }),
  success: CertificatePreviewResource,
  error: rpcProblems(CertificatesReadProblem),
})
  .middleware(PersonCredential)
  .pipe(access("certificates.issue", "SnapshotRead"));

/**
 * Records one issue of the certificate with the issuer, the authorizing seat, the instant, and
 * the content hash, and answers the PDF. Requires the observed certificate entity tag. A replay
 * of the idempotency key answers the same bytes.
 */
export const IssueCertificate = Rpc.make("certificates.issueCertificate", {
  payload: Schema.Struct({
    departmentId: DepartmentId,
    personId: PersonId,
    idempotencyKey: IdempotencyKey,
    ifMatch: StrongETag,
  }),
  success: CertificatePdf,
  error: rpcProblems(CertificatesIssueProblem),
})
  .middleware(PersonCredential)
  .pipe(access("certificates.issue", "Transaction"));

export class CertificatesRpcs extends RpcGroup.make(
  ReadCertificateScopes,
  ListDaysServed,
  ConfirmDaysServed,
  ListCertificates,
  ReadCertificate,
  IssueCertificate,
) {}
