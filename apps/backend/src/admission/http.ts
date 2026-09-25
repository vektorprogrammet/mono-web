/** Native HttpApi composition for admission and public application endpoints. */
import { ExternalNativeApi } from "@vektorprogrammet/http-api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { webHandler } from "../http-api/problem.js";
import {
  createAdmissionPeriod,
  registerReturningAssistant,
  reviseAdmissionPeriod,
  submitApplication,
} from "./http-commands.js";
import type { AdmissionApiHttpOptions } from "./http-context.js";
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
          webHandler(request, (webRequest) => listAdmissionPeriods(webRequest, input)),
        )
        .handleRaw("createAdmissionPeriod", ({ request }) =>
          webHandler(request, (webRequest) => createAdmissionPeriod(webRequest, input)),
        )
        .handleRaw("reviseAdmissionPeriod", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            reviseAdmissionPeriod(webRequest, params.admissionPeriodId, input),
          ),
        )
        .handleRaw("listOpenAdmissionPeriods", ({ request }) =>
          webHandler(request, (webRequest) => listOpenAdmissionPeriods(webRequest, input)),
        )
        .handleRaw("listApplicationOptions", ({ request }) =>
          webHandler(request, (webRequest) => listApplicationOptions(webRequest, input)),
        )
        .handleRaw("submitApplication", ({ request }) =>
          webHandler(request, (webRequest) => submitApplication(webRequest, input)),
        )
        .handleRaw("readApplicationConfirmation", ({ request, params }) =>
          webHandler(request, (webRequest) =>
            readApplicationConfirmation(webRequest, params.applicationId, input),
          ),
        )
        .handleRaw("readApplicantProgress", ({ request }) =>
          webHandler(request, (webRequest) => readApplicantProgress(webRequest, input)),
        )
        .handleRaw("readReturningAssistantOptions", ({ request }) =>
          webHandler(request, (webRequest) => readReturningAssistantOptions(webRequest, input)),
        )
        .handleRaw("registerReturningAssistant", ({ request }) =>
          webHandler(request, (webRequest) => registerReturningAssistant(webRequest, input)),
        ),
    ),
  );
