import { Database } from "../database/service.js";
import { Effect, Layer } from "effect";
import {
  executeAdmissionPeriodCommand,
  listAdmissionPeriodsForManagement,
  listOpenAdmissionPeriods,
} from "../admission-period/postgres.js";
import {
  executePublicApplicationCommand,
  findPublicApplicationConfirmation,
  listPublicApplicationCatalog,
} from "../application/postgres.js";
import { Admissions } from "./service.js";

export const AdmissionsLive = Layer.effect(
  Admissions,
  Effect.gen(function* () {
    const database = yield* Database;
    return Admissions.of({
      executeAdmissionPeriod: (input, context) =>
        executeAdmissionPeriodCommand(input, context).pipe(
          Effect.provideService(Database, database),
        ),
      listAdmissionPeriodsForManagement: (context) =>
        listAdmissionPeriodsForManagement(context).pipe(Effect.provideService(Database, database)),
      listOpenAdmissionPeriods: (now) =>
        listOpenAdmissionPeriods(now).pipe(Effect.provideService(Database, database)),
      executePublicApplication: (input, context) =>
        executePublicApplicationCommand(input, context).pipe(
          Effect.provideService(Database, database),
        ),
      listPublicApplicationCatalog: (context) =>
        listPublicApplicationCatalog(context).pipe(Effect.provideService(Database, database)),
      findPublicApplicationConfirmation: (applicationId) =>
        findPublicApplicationConfirmation(applicationId).pipe(
          Effect.provideService(Database, database),
        ),
    });
  }),
);
