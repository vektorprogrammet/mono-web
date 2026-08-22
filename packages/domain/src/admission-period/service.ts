import { Context, Effect } from "effect";
import type {
  AdmissionApplicationSubmitContext,
  AdmissionApplicationTransactionResult,
} from "./application.js";
import type { AdmissionPeriodFailure, AdmissionApplicationFailure } from "./errors.js";
import type { AdmissionPeriodOutboxRequest } from "./effects.js";
import type {
  AdmissionPeriod,
  AdmissionPeriodActor,
  AdmissionPeriodObservation,
  AdmissionPeriodProjection,
} from "./schema.js";

export interface AdmissionPeriodCommandContext {
  readonly actor: AdmissionPeriodActor;
  readonly now: string;
  /** A caller-generated identity may be supplied by the transport adapter. */
  readonly admissionPeriodId?: string;
}

export interface AdmissionPeriodManagementContext {
  readonly actor: AdmissionPeriodActor;
  readonly now: string;
}

export interface AdmissionPeriodTransactionResult {
  readonly period: AdmissionPeriod;
  readonly observation: AdmissionPeriodObservation;
  readonly replayed: boolean;
  readonly outboxCount: number;
}

export interface AdmissionPeriodAuthorityShape {
  readonly execute: (
    input: unknown,
    context: AdmissionPeriodCommandContext,
  ) => Effect.Effect<AdmissionPeriodTransactionResult, AdmissionPeriodFailure>;
  readonly listForManagement: (
    context: AdmissionPeriodManagementContext,
  ) => Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure>;
  readonly listOpen: (
    now: string,
  ) => Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure>;
  readonly submitApplication: (
    input: unknown,
    context: AdmissionApplicationSubmitContext,
  ) => Effect.Effect<AdmissionApplicationTransactionResult, AdmissionApplicationFailure>;
}

export class AdmissionPeriodAuthority extends Context.Service<
  AdmissionPeriodAuthority,
  AdmissionPeriodAuthorityShape
>()("@vektorprogrammet/domain/AdmissionPeriodAuthority") {}

export const executeAdmissionPeriodCommand = (
  input: unknown,
  context: AdmissionPeriodCommandContext,
) => AdmissionPeriodAuthority.use(({ execute }) => execute(input, context));

export const listAdmissionPeriodsForManagement = (context: AdmissionPeriodManagementContext) =>
  AdmissionPeriodAuthority.use(({ listForManagement }) => listForManagement(context));

export const listOpenAdmissionPeriods = (now: string) =>
  AdmissionPeriodAuthority.use(({ listOpen }) => listOpen(now));

export const submitAdmissionApplication = (
  input: unknown,
  context: AdmissionApplicationSubmitContext,
) => AdmissionPeriodAuthority.use(({ submitApplication }) => submitApplication(input, context));

export type { AdmissionPeriodOutboxRequest };
