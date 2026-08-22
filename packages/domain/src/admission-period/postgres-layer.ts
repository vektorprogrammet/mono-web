import * as PgClient from "@effect/sql-pg/PgClient";
import { Effect, Layer } from "effect";
import {
  executeAdmissionApplicationCommand,
  executeAdmissionPeriodCommand,
  listAdmissionPeriodsForManagement,
  listOpenAdmissionPeriods,
  submitAdmissionApplication,
} from "./postgres.js";
import { AdmissionPeriodAuthority } from "./service.js";

export const AdmissionPeriodAuthorityPostgres = Layer.effect(
  AdmissionPeriodAuthority,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    return AdmissionPeriodAuthority.of({
      execute: (input, context) =>
        executeAdmissionPeriodCommand(input, context).pipe(
          Effect.provideService(PgClient.PgClient, sql),
        ),
      listForManagement: (context) =>
        listAdmissionPeriodsForManagement(context).pipe(
          Effect.provideService(PgClient.PgClient, sql),
        ),
      listOpen: (now) =>
        listOpenAdmissionPeriods(now).pipe(Effect.provideService(PgClient.PgClient, sql)),
      submitApplication: (input, context) =>
        submitAdmissionApplication(input, context).pipe(
          Effect.provideService(PgClient.PgClient, sql),
        ),
    });
  }),
);

export const makeAdmissionPeriodPostgresLayer = PgClient.layer;

export { executeAdmissionApplicationCommand };
