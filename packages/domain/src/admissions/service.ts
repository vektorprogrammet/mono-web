import { Context, Effect } from "effect";
import type {
  AdmissionPeriodCommandContext,
  AdmissionPeriodManagementContext,
  AdmissionPeriodTransactionResult,
} from "../admission-period/context.js";
import type { AdmissionPeriodFailure } from "../admission-period/errors.js";
import {
  type AdmissionPeriodProjection,
  type AdmissionPeriodCommand,
} from "../admission-period/schema.js";
import type {
  ApplicantContactProjectionFailure,
  PublicApplicationError,
} from "../application/errors.js";
import {
  type ApplicantContactProjection,
  type ApplicantProgressResponse,
  type PublicApplicationCatalogContext,
  type PublicApplicationCatalogHttpSource,
  type PublicApplicationConfirmation,
  type PublicApplicationSubmitContext,
  type PublicApplicationId,
  type PublicApplicationSubmitResult,
  type PublicApplicationSubmitInput,
} from "../application/schema.js";

export interface AdmissionsOperations {
  readonly executeAdmissionPeriod: (
    input: AdmissionPeriodCommand,
    context: AdmissionPeriodCommandContext,
  ) => Effect.Effect<AdmissionPeriodTransactionResult, AdmissionPeriodFailure>;
  readonly listAdmissionPeriodsForManagement: (
    context: AdmissionPeriodManagementContext,
  ) => Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure>;
  readonly listOpenAdmissionPeriods: (
    now: string,
  ) => Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure>;
  readonly executePublicApplication: (
    input: PublicApplicationSubmitInput,
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
  readonly readApplicantProgress: (
    personId: string,
    now: string,
  ) => Effect.Effect<ApplicantProgressResponse, PublicApplicationError>;
}

export class Admissions extends Context.Service<Admissions, AdmissionsOperations>()(
  "@vektorprogrammet/domain/Admissions",
) {}
