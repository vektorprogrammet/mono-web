/** Native HttpApi composition for admission and public application endpoints. */
import {
  AdmissionsCreateAdmissionPeriodProblem,
  AdmissionsListAdmissionPeriodsProblem,
  AdmissionsListApplicationOptionsProblem,
  AdmissionsListOpenAdmissionPeriodsProblem,
  AdmissionsReadApplicantProgressProblem,
  AdmissionsReadApplicationConfirmationProblem,
  AdmissionsReadReturningAssistantOptionsProblem,
  AdmissionsRegisterReturningAssistantProblem,
  AdmissionsReviseAdmissionPeriodProblem,
  AdmissionsSubmitApplicationProblem,
  ExternalNativeApi,
} from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { toHttpApiResponse } from "../http-api/transport.js";
import {
  createAdmissionPeriod,
  registerReturningAssistant,
  reviseAdmissionPeriod,
  submitApplication,
} from "./http-commands.js";
import type { AdmissionApiHttpOptions } from "./http-context.js";
import { admissionHttpErrorResponse } from "./http-problem.js";
import {
  listAdmissionPeriods,
  listApplicationOptions,
  listOpenAdmissionPeriods,
  readApplicantProgress,
  readApplicationConfirmation,
  readReturningAssistantOptions,
} from "./http-reads.js";

/** Each endpoint answers an unclassified failure with its own union's unavailable problem. */
const problemResponses = {
  listAdmissionPeriods: admissionHttpErrorResponse(AdmissionsListAdmissionPeriodsProblem),
  createAdmissionPeriod: admissionHttpErrorResponse(AdmissionsCreateAdmissionPeriodProblem),
  reviseAdmissionPeriod: admissionHttpErrorResponse(AdmissionsReviseAdmissionPeriodProblem),
  listOpenAdmissionPeriods: admissionHttpErrorResponse(AdmissionsListOpenAdmissionPeriodsProblem),
  listApplicationOptions: admissionHttpErrorResponse(AdmissionsListApplicationOptionsProblem),
  submitApplication: admissionHttpErrorResponse(AdmissionsSubmitApplicationProblem),
  readApplicationConfirmation: admissionHttpErrorResponse(
    AdmissionsReadApplicationConfirmationProblem,
  ),
  readApplicantProgress: admissionHttpErrorResponse(AdmissionsReadApplicantProgressProblem),
  readReturningAssistantOptions: admissionHttpErrorResponse(
    AdmissionsReadReturningAssistantOptionsProblem,
  ),
  registerReturningAssistant: admissionHttpErrorResponse(
    AdmissionsRegisterReturningAssistantProblem,
  ),
};

/** Native HttpApi implementations for admission and public application endpoints. */
export const AdmissionsApiHandlers = (input: AdmissionApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "admissions", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listAdmissionPeriods", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listAdmissionPeriods(webRequest, input),
            problemResponses.listAdmissionPeriods,
          ),
        )
        .handleRaw("createAdmissionPeriod", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createAdmissionPeriod(webRequest, input),
            problemResponses.createAdmissionPeriod,
          ),
        )
        .handleRaw("reviseAdmissionPeriod", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => reviseAdmissionPeriod(webRequest, params.admissionPeriodId, input),
            problemResponses.reviseAdmissionPeriod,
          ),
        )
        .handleRaw("listOpenAdmissionPeriods", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listOpenAdmissionPeriods(webRequest, input),
            problemResponses.listOpenAdmissionPeriods,
          ),
        )
        .handleRaw("listApplicationOptions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listApplicationOptions(webRequest, input),
            problemResponses.listApplicationOptions,
          ),
        )
        .handleRaw("submitApplication", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => submitApplication(webRequest, input),
            problemResponses.submitApplication,
          ),
        )
        .handleRaw("readApplicationConfirmation", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readApplicationConfirmation(webRequest, params.applicationId, input),
            problemResponses.readApplicationConfirmation,
          ),
        )
        .handleRaw("readApplicantProgress", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readApplicantProgress(webRequest, input),
            problemResponses.readApplicantProgress,
          ),
        )
        .handleRaw("readReturningAssistantOptions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readReturningAssistantOptions(webRequest, input),
            problemResponses.readReturningAssistantOptions,
          ),
        )
        .handleRaw("registerReturningAssistant", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => registerReturningAssistant(webRequest, input),
            problemResponses.registerReturningAssistant,
          ),
        ),
    ),
  );
