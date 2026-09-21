import { Database } from "../service.js";
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
  readApplicantContacts,
  readApplicantProgress,
} from "../application/postgres.js";
import { Admissions } from "@vektorprogrammet/domain/admissions";

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
      readApplicantContacts: (applicationIds) =>
        readApplicantContacts(applicationIds).pipe(Effect.provideService(Database, database)),
      readApplicantProgress: (personId, now) =>
        readApplicantProgress(personId, now).pipe(Effect.provideService(Database, database)),
    });
  }),
);
