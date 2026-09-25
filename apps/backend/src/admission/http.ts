/** Native HttpApi composition for admission and public application endpoints. */
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
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

/** Native HttpApi implementations for admission and public application endpoints. */
export const AdmissionsApiHandlers = (input: AdmissionApiHttpOptions) =>
  HttpApiBuilder.group(ExternalNativeApi, "admissions", (handlers) =>
    Effect.succeed(
      handlers
        .handleRaw("listAdmissionPeriods", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listAdmissionPeriods(webRequest, input),
            admissionHttpErrorResponse,
          ),
        )
        .handleRaw("createAdmissionPeriod", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => createAdmissionPeriod(webRequest, input),
            admissionHttpErrorResponse,
          ),
        )
        .handleRaw("reviseAdmissionPeriod", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => reviseAdmissionPeriod(webRequest, params.admissionPeriodId, input),
            admissionHttpErrorResponse,
          ),
        )
        .handleRaw("listOpenAdmissionPeriods", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listOpenAdmissionPeriods(webRequest, input),
            admissionHttpErrorResponse,
          ),
        )
        .handleRaw("listApplicationOptions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => listApplicationOptions(webRequest, input),
            admissionHttpErrorResponse,
          ),
        )
        .handleRaw("submitApplication", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => submitApplication(webRequest, input),
            admissionHttpErrorResponse,
          ),
        )
        .handleRaw("readApplicationConfirmation", ({ request, params }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readApplicationConfirmation(webRequest, params.applicationId, input),
            admissionHttpErrorResponse,
          ),
        )
        .handleRaw("readApplicantProgress", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readApplicantProgress(webRequest, input),
            admissionHttpErrorResponse,
          ),
        )
        .handleRaw("readReturningAssistantOptions", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => readReturningAssistantOptions(webRequest, input),
            admissionHttpErrorResponse,
          ),
        )
        .handleRaw("registerReturningAssistant", ({ request }) =>
          toHttpApiResponse(
            request,
            (webRequest) => registerReturningAssistant(webRequest, input),
            admissionHttpErrorResponse,
          ),
        ),
    ),
  );
