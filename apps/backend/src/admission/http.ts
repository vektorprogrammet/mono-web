/** Generated native HttpApi binding for admission and public application endpoints. */
import {
  createAdmissionPeriod as createAdmissionPeriodEndpoint,
  ExternalNativeApi,
  listAdmissionPeriods as listAdmissionPeriodsEndpoint,
  listApplicationOptions as listApplicationOptionsEndpoint,
  listOpenAdmissionPeriods as listOpenAdmissionPeriodsEndpoint,
  readApplicantProgress as readApplicantProgressEndpoint,
  readApplicationConfirmation as readApplicationConfirmationEndpoint,
  readReturningAssistantOptions as readReturningAssistantOptionsEndpoint,
  registerReturningAssistant as registerReturningAssistantEndpoint,
  reviseAdmissionPeriod as reviseAdmissionPeriodEndpoint,
  submitApplication as submitApplicationEndpoint,
} from "@vektorprogrammet/http-api";
import type { HttpApiGroup } from "effect/unstable/httpapi";
import {
  AdmissionsApiHandlers as GeneratedAdmissionsApiHandlers,
  type AdmissionsGuards,
  type AdmissionsRawHandlers,
} from "../../.effx/generated/admissions-handlers.js";
import { unreachable, webHandler } from "../http-api/problem.js";
import {
  createAdmissionPeriod,
  registerReturningAssistant,
  reviseAdmissionPeriod,
  submitApplication,
} from "./http-commands.js";
import type { AdmissionApiHttpOptions } from "./http-context.js";
import { anonymousGuard, personGuard } from "./http-guard.js";
import {
  listAdmissionPeriods,
  listApplicationOptions,
  listOpenAdmissionPeriods,
  readApplicantProgress,
  readApplicationConfirmation,
  readReturningAssistantOptions,
} from "./http-reads.js";

type AdmissionsEndpoints = HttpApiGroup.Endpoints<
  (typeof ExternalNativeApi)["groups"]["admissions"]
>;

/**
 * The guards evaluate each endpoint's declared AccessSpec at the decision point of its raw
 * handler. Every admission AccessSpec reveals its denials, so authorization never answers 404.
 */
export const admissionsGuards = {
  "admissions.createAdmissionPeriod": () =>
    personGuard("admissions.createAdmissionPeriod", createAdmissionPeriodEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "admissions.listAdmissionPeriods": () =>
    personGuard("admissions.listAdmissionPeriods", listAdmissionPeriodsEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "admissions.listApplicationOptions": () =>
    anonymousGuard("admissions.listApplicationOptions", listApplicationOptionsEndpoint),
  "admissions.listOpenAdmissionPeriods": () =>
    anonymousGuard("admissions.listOpenAdmissionPeriods", listOpenAdmissionPeriodsEndpoint),
  "admissions.readApplicantProgress": () =>
    personGuard("admissions.readApplicantProgress", readApplicantProgressEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "admissions.readApplicationConfirmation": () =>
    anonymousGuard("admissions.readApplicationConfirmation", readApplicationConfirmationEndpoint),
  "admissions.readReturningAssistantOptions": () =>
    personGuard(
      "admissions.readReturningAssistantOptions",
      readReturningAssistantOptionsEndpoint,
    ).pipe(unreachable("resource.not-found")),
  "admissions.registerReturningAssistant": () =>
    personGuard("admissions.registerReturningAssistant", registerReturningAssistantEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "admissions.reviseAdmissionPeriod": () =>
    personGuard("admissions.reviseAdmissionPeriod", reviseAdmissionPeriodEndpoint).pipe(
      unreachable("resource.not-found"),
    ),
  "admissions.submitApplication": () =>
    anonymousGuard("admissions.submitApplication", submitApplicationEndpoint),
} satisfies AdmissionsGuards<AdmissionsEndpoints>;

/** Binds the ten raw HTTP effects without moving their authority, rate-limit or receipt boundaries. */
export const AdmissionsApiHandlers = (input: AdmissionApiHttpOptions) => {
  const raw = {
    listAdmissionPeriods: ({ request }, authorize) =>
      webHandler(request, (webRequest) => listAdmissionPeriods(webRequest, input, authorize)),
    createAdmissionPeriod: ({ request }, authorize) =>
      webHandler(request, (webRequest) => createAdmissionPeriod(webRequest, input, authorize)),
    reviseAdmissionPeriod: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        reviseAdmissionPeriod(webRequest, params.admissionPeriodId, input, authorize),
      ),
    listOpenAdmissionPeriods: ({ request }, authorize) =>
      webHandler(request, (webRequest) => listOpenAdmissionPeriods(webRequest, input, authorize)),
    listApplicationOptions: ({ request }, authorize) =>
      webHandler(request, (webRequest) => listApplicationOptions(webRequest, input, authorize)),
    submitApplication: ({ request }, authorize) =>
      webHandler(request, (webRequest) => submitApplication(webRequest, input, authorize)),
    readApplicationConfirmation: ({ request, params }, authorize) =>
      webHandler(request, (webRequest) =>
        readApplicationConfirmation(webRequest, params.applicationId, input, authorize),
      ),
    readApplicantProgress: ({ request }, authorize) =>
      webHandler(request, (webRequest) => readApplicantProgress(webRequest, input, authorize)),
    readReturningAssistantOptions: ({ request }, authorize) =>
      webHandler(request, (webRequest) =>
        readReturningAssistantOptions(webRequest, input, authorize),
      ),
    registerReturningAssistant: ({ request }, authorize) =>
      webHandler(request, (webRequest) => registerReturningAssistant(webRequest, input, authorize)),
  } satisfies AdmissionsRawHandlers<AdmissionsEndpoints, typeof admissionsGuards>;

  return GeneratedAdmissionsApiHandlers({ raw, guards: admissionsGuards });
};
