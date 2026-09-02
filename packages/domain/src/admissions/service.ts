import { Context, Effect } from "effect";
import type {
  AdmissionPeriodCommandContext,
  AdmissionPeriodManagementContext,
  AdmissionPeriodTransactionResult,
} from "../admission-period/context.js";
import type { AdmissionPeriodFailure } from "../admission-period/errors.js";
import type { AdmissionPeriodProjection } from "../admission-period/schema.js";
import type {
  ApplicantContactProjectionFailure,
  PublicApplicationError,
} from "../application/errors.js";
import type {
  ApplicantContactProjection,
  PublicApplicationCatalogContext,
  PublicApplicationCatalogHttpSource,
  PublicApplicationConfirmation,
  PublicApplicationSubmitContext,
  PublicApplicationId,
  PublicApplicationSubmitResult,
} from "../application/schema.js";

export interface AdmissionsShape {
  readonly executeAdmissionPeriod: (
    input: unknown,
    context: AdmissionPeriodCommandContext,
  ) => Effect.Effect<AdmissionPeriodTransactionResult, AdmissionPeriodFailure>;
  readonly listAdmissionPeriodsForManagement: (
    context: AdmissionPeriodManagementContext,
  ) => Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure>;
  readonly listOpenAdmissionPeriods: (
    now: string,
  ) => Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure>;
  readonly executePublicApplication: (
    input: unknown,
    context: PublicApplicationSubmitContext,
  ) => Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError>;
  readonly listPublicApplicationCatalog: (
    context: PublicApplicationCatalogContext,
  ) => Effect.Effect<PublicApplicationCatalogHttpSource, PublicApplicationError>;
  readonly findPublicApplicationConfirmation: (
    applicationId: string,
  ) => Effect.Effect<PublicApplicationConfirmation, PublicApplicationError>;
  readonly readApplicantContacts: (
    applicationIds: ReadonlyArray<PublicApplicationId>,
  ) => Effect.Effect<ReadonlyArray<ApplicantContactProjection>, ApplicantContactProjectionFailure>;
}

export class Admissions extends Context.Service<Admissions, AdmissionsShape>()(
  "@vektorprogrammet/domain/Admissions",
) {}
