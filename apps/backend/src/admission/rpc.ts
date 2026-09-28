/**
 * The AdmissionsRpcs handlers. A read resolves the credential and the authority as the HTTP
 * handler did, and evaluates the RPC's AccessSpec; a public read evaluates it for the anonymous
 * principal. A command resolves them inside the serializable transaction that commits it, and
 * stores its success as a command receipt, so a retry with the same idempotency key replays the
 * first answer.
 */
import { AdmissionsRpcs } from "@vektorprogrammet/rpc";
import type { NativeRpcOptions } from "../rpc/options.js";
import {
  createAdmissionPeriod,
  registerReturningAssistant,
  reviseAdmissionPeriod,
  submitApplication,
} from "./commands.js";
import {
  listAdmissionPeriods,
  listApplicationOptions,
  listOpenAdmissionPeriods,
  readApplicantProgress,
  readApplicationConfirmation,
  readReturningAssistantOptions,
} from "./reads.js";

/** The AdmissionsRpcs handlers. */
export const AdmissionsRpcHandlers = (options: NativeRpcOptions) =>
  AdmissionsRpcs.toLayer({
    "admissions.listOpenAdmissionPeriods": (_payload, { headers }) =>
      listOpenAdmissionPeriods(headers, options),
    "admissions.listApplicationOptions": (_payload, { headers }) =>
      listApplicationOptions(headers, options),
    "admissions.submitApplication": (payload, { headers }) =>
      submitApplication(headers, payload, options),
    "admissions.readApplicationConfirmation": ({ applicationId }, { headers }) =>
      readApplicationConfirmation(headers, applicationId, options),
    "admissions.readApplicantProgress": (_payload, { headers }) =>
      readApplicantProgress(headers, options),
    "admissions.listAdmissionPeriods": (_payload, { headers }) =>
      listAdmissionPeriods(headers, options),
    "admissions.createAdmissionPeriod": (payload, { headers }) =>
      createAdmissionPeriod(headers, payload, options),
    "admissions.reviseAdmissionPeriod": (payload, { headers }) =>
      reviseAdmissionPeriod(headers, payload, options),
    "admissions.readReturningAssistantOptions": (_payload, { headers }) =>
      readReturningAssistantOptions(headers, options),
    "admissions.registerReturningAssistant": (payload, { headers }) =>
      registerReturningAssistant(headers, payload, options),
  });
