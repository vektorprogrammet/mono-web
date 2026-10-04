/**
 * Schemas and parameters of the public contracts for admission periods and applications. The
 * operations are declared in `admissions.effx.ts`.
 *
 * @since 0.1.0
 */
import { AdmissionPeriodId } from "@vektorprogrammet/domain/admission-period";
import {
  ApplicantProgressItemSchema,
  ApplicantProgressResponseSchema,
  ApplicantProgressStateSchema,
  PublicApplicationIdSchema,
  ReturningAssistantRegistrationInputSchema,
  type ApplicantProgressItem,
  type ApplicantProgressResponse,
  type ApplicantProgressState,
} from "@vektorprogrammet/domain/application";
import { Schema } from "effect";

export {
  AdmissionPeriodId,
  ApplicantProgressItemSchema,
  ApplicantProgressResponseSchema,
  ApplicantProgressStateSchema,
  PublicApplicationIdSchema,
  ReturningAssistantRegistrationInputSchema,
};

export type { ApplicantProgressItem, ApplicantProgressResponse, ApplicantProgressState };

/** The empty input of an operation that takes no path, query or body. */
export const EmptyAdmissionsInput = Schema.Struct({});

/** The public application that one confirmation read addresses. */
export const PublicApplicationParams = Schema.Struct({
  applicationId: PublicApplicationIdSchema,
});

/** The admission period that one revision addresses. */
export const AdmissionPeriodParams = Schema.Struct({ admissionPeriodId: AdmissionPeriodId });
