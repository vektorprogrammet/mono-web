import { Effect, Schema as S } from "effect";
import {
  SchoolSurveyAdminCatalogResource,
  SchoolSurveyAdminListResource,
  SchoolSurveyAdminResource,
  SchoolSurveyResultsResource,
  SchoolSurveysBridgeFailure,
  SchoolSurveysBridgeOperationJson,
  schoolSurveysBridgeFailure,
  type SchoolSurveyCloseCommand,
  type SchoolSurveyCreateCommand,
  type SchoolSurveyListInput,
  type SchoolSurveysBridgeFailure as SchoolSurveysBridgeFailureType,
  type SchoolSurveysBridgeOperation,
} from "./bridge";

type Catalog = S.Schema.Type<typeof SchoolSurveyAdminCatalogResource>;
type SurveyList = S.Schema.Type<typeof SchoolSurveyAdminListResource>;
type Survey = S.Schema.Type<typeof SchoolSurveyAdminResource>;
type Results = S.Schema.Type<typeof SchoolSurveyResultsResource>;

export interface SchoolSurveysOperations {
  readonly readAdminCatalog: () => Effect.Effect<Catalog, SchoolSurveysBridgeFailureType>;
  readonly listAdminSurveys: (
    input: SchoolSurveyListInput,
  ) => Effect.Effect<SurveyList, SchoolSurveysBridgeFailureType>;
  readonly createAdminSurvey: (
    command: SchoolSurveyCreateCommand,
  ) => Effect.Effect<Survey, SchoolSurveysBridgeFailureType>;
  readonly closeAdminSurvey: (
    command: SchoolSurveyCloseCommand,
  ) => Effect.Effect<Survey, SchoolSurveysBridgeFailureType>;
  readonly readAdminResults: (input: { readonly surveyId: string }) => Effect.Effect<
    Results,
    SchoolSurveysBridgeFailureType
  >;
}

export interface SchoolSurveysClient {
  readonly surveys: SchoolSurveysOperations;
}

const bridgeUrl = `${import.meta.env.BASE_URL}surveys`;

const bridgeRequest = <A>(
  schema: S.Decoder<A, never>,
  operation?: SchoolSurveysBridgeOperation,
): Effect.Effect<A, SchoolSurveysBridgeFailureType> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        bridgeUrl,
        operation === undefined
          ? {
              method: "GET",
              credentials: "same-origin",
              headers: { accept: "application/json" },
            }
          : {
              method: "POST",
              credentials: "same-origin",
              headers: {
                accept: "application/json",
                "content-type": "application/json",
              },
              body: S.encodeSync(SchoolSurveysBridgeOperationJson)(operation),
            },
      );
      const payload = (await response.json().catch(() => null)) as unknown;
      return { response, payload };
    },
    catch: () => schoolSurveysBridgeFailure("Network"),
  }).pipe(
    Effect.flatMap(({ response, payload }) => {
      if (!response.ok) {
        return S.decodeUnknownEffect(SchoolSurveysBridgeFailure)(payload, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(() => schoolSurveysBridgeFailure("SurveyDecodeError")),
          Effect.flatMap(Effect.fail),
        );
      }
      return S.decodeUnknownEffect(schema)(payload, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => schoolSurveysBridgeFailure("SurveyDecodeError")));
    }),
  );

export const schoolSurveyResultsCsvUrl = (surveyId: string): string =>
  `${bridgeUrl}?export=${encodeURIComponent(surveyId)}`;

export const createBrowserSchoolSurveysClient = (): SchoolSurveysClient => ({
  surveys: {
    readAdminCatalog: () => bridgeRequest(SchoolSurveyAdminCatalogResource),
    listAdminSurveys: (query) =>
      bridgeRequest(SchoolSurveyAdminListResource, {
        operation: "list",
        query,
      }),
    createAdminSurvey: (command) =>
      bridgeRequest(SchoolSurveyAdminResource, {
        operation: "create",
        ...command,
      }),
    closeAdminSurvey: (command) =>
      bridgeRequest(SchoolSurveyAdminResource, {
        operation: "close",
        ...command,
      }),
    readAdminResults: ({ surveyId }) =>
      bridgeRequest(SchoolSurveyResultsResource, { operation: "results", surveyId: surveyId as never }),
  },
});
