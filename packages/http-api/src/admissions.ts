/**
 * Public HTTP contracts for admission periods and applications.
 *
 * @since 0.1.0
 */
import {
  AdmissionPeriodCommandId,
  AdmissionPeriodId,
  AdmissionPeriodObservationSchema,
  AdmissionPeriodProjectionSchema,
  Rfc3339InstantSchema,
  RevisionSchema,
} from "@vektorprogrammet/domain/admission-period";
import {
  PublicApplicationCatalogSchema,
  PublicApplicationConfirmationSchema,
  PublicApplicationSubmitInputSchema,
  PublicApplicationSubmitObservationSchema,
} from "@vektorprogrammet/domain/application";
import { DepartmentId, SemesterId } from "@vektorprogrammet/domain/organization";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { annotateAccessSpec, anonymousNativeAccess, personNativeAccess } from "./access.js";
import { errorBody, operationAnnotations, PersonSecurity } from "./common.js";

/**
 * Admission-period create payload accepted by the native transport.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const CreateAdmissionPeriodPayload = Schema.Struct({
  commandId: AdmissionPeriodCommandId,
  semesterId: SemesterId,
  startAt: Rfc3339InstantSchema,
  endAt: Rfc3339InstantSchema,
  departmentId: Schema.optional(DepartmentId),
}).annotate({
  identifier: "CreateAdmissionPeriodPayload",
  description: "Creates an admission window.",
  examples: [
    {
      commandId: AdmissionPeriodCommandId.make("adm-period-create-0080"),
      semesterId: SemesterId.make("2026-hosten"),
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-09-15T23:59:59.999Z",
      departmentId: DepartmentId.make("1"),
    },
  ],
});

/**
 * Admission-period revise payload; the period identity remains in the path.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const ReviseAdmissionPeriodPayload = Schema.Struct({
  commandId: AdmissionPeriodCommandId,
  expectedRevision: RevisionSchema,
  startAt: Rfc3339InstantSchema,
  endAt: Rfc3339InstantSchema,
}).annotate({
  identifier: "ReviseAdmissionPeriodPayload",
  description: "Revises an admission window.",
  examples: [
    {
      commandId: AdmissionPeriodCommandId.make("adm-period-revise-0080"),
      expectedRevision: 0,
      startAt: "2026-08-01T00:00:00.000Z",
      endAt: "2026-09-20T23:59:59.999Z",
    },
  ],
});

/**
 * Admission-period list envelope.
 *
 * @since 0.1.0
 * @category Schemas
 */
export const AdmissionPeriodListResponse = Schema.Struct({
  items: Schema.Array(AdmissionPeriodProjectionSchema),
  totalItems: Schema.Int,
}).annotate({
  identifier: "AdmissionPeriodListResponse",
  description: "Admission periods and the matching total count.",
  examples: [
    {
      items: [
        {
          id: AdmissionPeriodId.make("period-1"),
          departmentId: DepartmentId.make("1"),
          semesterId: SemesterId.make("2026-hosten"),
          startAt: "2026-08-01T00:00:00.000Z",
          endAt: "2026-09-15T23:59:59.999Z",
          revision: 0,
          lastCommandId: AdmissionPeriodCommandId.make("adm-period-create-0080"),
          eligible: true,
        },
      ],
      totalItems: 1,
    },
  ],
});

const AdmissionForbiddenResponse = errorBody(
  "AdmissionForbiddenResponse",
  ["InactiveActor", "AdmissionRoleDenied", "AdmissionScopeDenied"],
  403,
);
const AdmissionNotFoundResponse = errorBody(
  "AdmissionNotFoundResponse",
  ["DepartmentNotFound", "AdmissionPeriodNotFound", "PublicApplicationNotFound"],
  404,
);
const AdmissionConflictResponse = errorBody(
  "AdmissionConflictResponse",
  [
    "NoEligibleAdmissionPeriod",
    "AmbiguousAdmissionPeriod",
    "DuplicatePublicApplication",
    "DuplicatePublicApplicationCommandConflict",
    "AdmissionPeriodAlreadyExists",
    "StaleAdmissionPeriodRevision",
    "DuplicateAdmissionPeriodCommandConflict",
  ],
  409,
);
const AdmissionTooLargeResponse = errorBody(
  "AdmissionTooLargeResponse",
  ["RequestBodyTooLarge"],
  413,
);
const AdmissionDecodeResponse = errorBody(
  "AdmissionDecodeResponse",
  [
    "PublicApplicationDecodeError",
    "FieldOfStudyNotFound",
    "FieldOfStudyInactive",
    "FieldOfStudyDepartmentMismatch",
    "AdmissionPeriodDecodeError",
    "InvalidAdmissionPeriodWindow",
    "AdmissionWindowOutsideSemester",
  ],
  422,
);
const AdmissionRateLimitResponse = errorBody(
  "AdmissionRateLimitResponse",
  ["PublicApplicationRateLimitExceeded"],
  429,
);
const AdmissionUnavailableResponse = errorBody(
  "AdmissionUnavailableResponse",
  [
    "AdmissionPeriodPersistenceError",
    "PublicApplicationPersistenceError",
    "DepartmentRequired",
    "SemesterNotFound",
  ],
  503,
);
const PublicAdmissionErrors = [
  AdmissionNotFoundResponse,
  AdmissionConflictResponse,
  AdmissionTooLargeResponse,
  AdmissionDecodeResponse,
  AdmissionRateLimitResponse,
  AdmissionUnavailableResponse,
] as const;
const AdminAdmissionErrors = [AdmissionForbiddenResponse, ...PublicAdmissionErrors] as const;

const AdmissionObservation200 = AdmissionPeriodObservationSchema.pipe(HttpApiSchema.status(200));
const AdmissionObservation201 = AdmissionPeriodObservationSchema.pipe(HttpApiSchema.status(201));
const ApplicationObservation200 = PublicApplicationSubmitObservationSchema.pipe(
  HttpApiSchema.status(200),
);
const ApplicationObservation201 = PublicApplicationSubmitObservationSchema.pipe(
  HttpApiSchema.status(201),
);

/** @since 0.1.0 @category Endpoints */
export const ListOpenAdmissionPeriodsEndpoint = HttpApiEndpoint.get(
  "listOpenAdmissionPeriods",
  "/api/open-admission-periods",
  { success: AdmissionPeriodListResponse, error: PublicAdmissionErrors },
)
  .pipe((endpoint) =>
    annotateAccessSpec(endpoint, anonymousNativeAccess("admissions.public-open-periods")),
  )
  .annotateMerge(
    operationAnnotations(
      "List open admission periods",
      "Returns currently open native admission periods.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ReadApplicationCatalogEndpoint = HttpApiEndpoint.get(
  "listApplicationOptions",
  "/api/application-options",
  { success: PublicApplicationCatalogSchema, error: PublicAdmissionErrors },
)
  .pipe((endpoint) =>
    annotateAccessSpec(endpoint, anonymousNativeAccess("admissions.public-application-options")),
  )
  .annotateMerge(
    operationAnnotations(
      "List application options",
      "Returns departments and fields open to applicants.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const SubmitApplicationEndpoint = HttpApiEndpoint.post(
  "submitApplication",
  "/api/applications",
  {
    payload: PublicApplicationSubmitInputSchema,
    success: [ApplicationObservation200, ApplicationObservation201],
    error: PublicAdmissionErrors,
  },
)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      anonymousNativeAccess("admissions.application-create", "Transaction"),
    ),
  )
  .annotateMerge(
    operationAnnotations("Submit application", "Submits or replays a public applicant command."),
  );

/** @since 0.1.0 @category Endpoints */
export const ReadApplicationConfirmationEndpoint = HttpApiEndpoint.get(
  "readApplicationConfirmation",
  "/api/applications/:applicationId",
  {
    params: { applicationId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))) },
    success: PublicApplicationConfirmationSchema,
    error: PublicAdmissionErrors,
  },
)
  .pipe((endpoint) =>
    annotateAccessSpec(endpoint, anonymousNativeAccess("admissions.public-application-by-id")),
  )
  .annotateMerge(
    operationAnnotations(
      "Read application confirmation",
      "Returns the public confirmation projection.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ListAdmissionPeriodsEndpoint = HttpApiEndpoint.get(
  "listAdmissionPeriods",
  "/api/admission-periods",
  { success: AdmissionPeriodListResponse, error: AdminAdmissionErrors },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "admissions.read-periods",
        canonicalScopeResolver: "admissions.management-periods",
        decisionTime: "SnapshotRead",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "List admission periods",
      "Returns the management admission-period projection.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const CreateAdmissionPeriodEndpoint = HttpApiEndpoint.post(
  "createAdmissionPeriod",
  "/api/admission-periods",
  {
    payload: CreateAdmissionPeriodPayload,
    success: [AdmissionObservation200, AdmissionObservation201],
    error: AdminAdmissionErrors,
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "admissions.create-period",
        canonicalScopeResolver: "admissions.period-create",
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Create admission period",
      "Creates or replays an admission-period command.",
    ),
  );

/** @since 0.1.0 @category Endpoints */
export const ReviseAdmissionPeriodEndpoint = HttpApiEndpoint.patch(
  "reviseAdmissionPeriod",
  "/api/admission-periods/:admissionPeriodId",
  {
    params: { admissionPeriodId: AdmissionPeriodId },
    payload: ReviseAdmissionPeriodPayload,
    success: AdmissionObservation200,
    error: AdminAdmissionErrors,
  },
)
  .middleware(PersonSecurity)
  .pipe((endpoint) =>
    annotateAccessSpec(
      endpoint,
      personNativeAccess({
        capability: "admissions.revise-period",
        canonicalScopeResolver: "admissions.period-by-id",
        decisionTime: "Transaction",
      }),
    ),
  )
  .annotateMerge(
    operationAnnotations(
      "Revise admission period",
      "Revises or replays an admission-period command.",
    ),
  );

/**
 * Public applicant and administrative admission endpoints.
 *
 * @since 0.1.0
 * @category Groups
 */
export class AdmissionsApi extends HttpApiGroup.make("admissions")
  .add(
    ListOpenAdmissionPeriodsEndpoint,
    ReadApplicationCatalogEndpoint,
    SubmitApplicationEndpoint,
    ReadApplicationConfirmationEndpoint,
    ListAdmissionPeriodsEndpoint,
    CreateAdmissionPeriodEndpoint,
    ReviseAdmissionPeriodEndpoint,
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Admissions",
      description: "Public applicant and administrative admission-period API.",
    }),
  ) {}
