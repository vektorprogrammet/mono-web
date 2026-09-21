import { Layer } from "effect";
import {
  persistSchoolSurveyResponsePostgres,
  prepareSchoolSurveyResponsePostgres,
  readSchoolSurveyFormPostgres,
} from "./postgres.js";
import { SchoolSurveys } from "./service.js";

/** Live school-survey persistence whose effects consume the caller's Database. */
export const SchoolSurveysLive: Layer.Layer<SchoolSurveys> = Layer.succeed(
  SchoolSurveys,
  SchoolSurveys.of({
    readForm: readSchoolSurveyFormPostgres,
    prepareResponse: prepareSchoolSurveyResponsePostgres,
    persistResponse: persistSchoolSurveyResponsePostgres,
  }),
);
