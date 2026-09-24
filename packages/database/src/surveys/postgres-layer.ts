import { Effect, Layer } from "effect";
import { Database } from "../service.js";
import {
  closeSchoolSurveyAdminSurveyPostgres,
  createSchoolSurveyAdminSurveyPostgres,
  listSchoolSurveyAdminSurveysPostgres,
  persistSchoolSurveyResponsePostgres,
  prepareSchoolSurveyResponsePostgres,
  readSchoolSurveyAdminCatalogPostgres,
  readSchoolSurveyAdminResultsPostgres,
  readSchoolSurveyAdminSurveyPostgres,
  readSchoolSurveyFormPostgres,
} from "./postgres.js";
import { SchoolSurveys } from "@vektorprogrammet/domain/surveys";

/** Live school-survey persistence bound to the process Database. */
export const SchoolSurveysLive = Layer.effect(
  SchoolSurveys,
  Effect.gen(function* () {
    const database = yield* Database;

    return SchoolSurveys.of({
      readForm: (surveyId) =>
        readSchoolSurveyFormPostgres(surveyId).pipe(Effect.provideService(Database, database)),
      prepareResponse: (input) =>
        prepareSchoolSurveyResponsePostgres(input).pipe(Effect.provideService(Database, database)),
      persistResponse: (input) =>
        persistSchoolSurveyResponsePostgres(input).pipe(Effect.provideService(Database, database)),
      readAdminCatalog: (authority) =>
        readSchoolSurveyAdminCatalogPostgres(authority).pipe(
          Effect.provideService(Database, database),
        ),
      readAdminSurvey: (surveyId) =>
        readSchoolSurveyAdminSurveyPostgres(surveyId).pipe(
          Effect.provideService(Database, database),
        ),
      listAdminSurveys: (scope) =>
        listSchoolSurveyAdminSurveysPostgres(scope).pipe(Effect.provideService(Database, database)),
      createAdminSurvey: (command) =>
        createSchoolSurveyAdminSurveyPostgres(command).pipe(
          Effect.provideService(Database, database),
        ),
      closeAdminSurvey: (command) =>
        closeSchoolSurveyAdminSurveyPostgres(command).pipe(
          Effect.provideService(Database, database),
        ),
      readAdminResults: (surveyId) =>
        readSchoolSurveyAdminResultsPostgres(surveyId).pipe(
          Effect.provideService(Database, database),
        ),
    });
  }),
);
