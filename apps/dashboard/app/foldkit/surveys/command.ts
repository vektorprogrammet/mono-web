import { Effect } from "effect";
import { Command } from "foldkit";
import {
  SurveyId,
  type SchoolSurveyCloseCommand,
  type SchoolSurveyCreateCommand,
  type SchoolSurveyListInput,
  type SchoolSurveysBridgeFailure,
} from "./bridge";
import type { SchoolSurveysClient } from "./browser-client";
import {
  FailedCatalog,
  FailedClose,
  FailedCreate,
  FailedList,
  FailedResults,
  LoadedCatalog,
  LoadedList,
  LoadedResults,
  SucceededClose,
  SucceededCreate,
  type Message,
} from "./message";
import { SchoolSurveysFailure } from "./model";

export interface SchoolSurveysCommandFactories {
  readonly LoadCatalog: (args: { readonly requestId: number }) => Command.Command<Message>;
  readonly LoadList: (args: {
    readonly requestId: number;
    readonly query: SchoolSurveyListInput;
  }) => Command.Command<Message>;
  readonly Create: (args: {
    readonly requestId: number;
    readonly command: SchoolSurveyCreateCommand;
  }) => Command.Command<Message>;
  readonly Close: (args: {
    readonly requestId: number;
    readonly command: SchoolSurveyCloseCommand;
  }) => Command.Command<Message>;
  readonly LoadResults: (args: {
    readonly requestId: number;
    readonly surveyId: typeof SurveyId.Type;
  }) => Command.Command<Message>;
}

const failureMessage = (tag: SchoolSurveysBridgeFailure["error"]["tag"]): string => {
  switch (tag) {
    case "UnauthenticatedActor":
      return "Du må logge inn på nytt for å administrere undersøkelser.";
    case "NotInScope":
      return "Du har ikke tilgang til denne undersøkelsen.";
    case "SurveyNotFound":
      return "Undersøkelsen finnes ikke, eller er ikke tilgjengelig.";
    case "ValidationFailed":
      return "Kontroller feltene og prøv igjen.";
    case "CommandConflict":
      return "Undersøkelsen ble endret av en annen. Last den oppdaterte oversikten før du prøver igjen.";
    case "SurveyDecodeError":
      return "Serveren svarte med ugyldige undersøkelsesdata.";
    case "SurveyPersistenceError":
      return "Undersøkelsen kunne ikke lagres akkurat nå.";
    case "Network":
      return "Tjenesten er midlertidig utilgjengelig.";
    case "Configuration":
      return "Undersøkelsesadministrasjonen er ikke konfigurert.";
  }
};

export const failureFrom = (error: SchoolSurveysBridgeFailure): SchoolSurveysFailure => {
  const tag = error.error.tag;
  const message = failureMessage(tag);

  return tag === "UnauthenticatedActor" || tag === "NotInScope"
    ? SchoolSurveysFailure.cases.Denied.make({ tag, message })
    : SchoolSurveysFailure.cases.Failed.make({ tag, message });
};

export const commandsFor = (
  client: SchoolSurveysClient,
): SchoolSurveysCommandFactories => ({
  LoadCatalog: ({ requestId }) => ({
    name: "LoadSchoolSurveyAdminCatalog",
    args: { requestId },
    effect: client.surveys.readAdminCatalog().pipe(
      Effect.map((catalog) => LoadedCatalog({ requestId, catalog })),
      Effect.catch((error) =>
        Effect.succeed(FailedCatalog({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
  LoadList: ({ requestId, query }) => ({
    name: "ListSchoolSurveys",
    args: { requestId, query },
    effect: client.surveys.listAdminSurveys(query).pipe(
      Effect.map((list) => LoadedList({ requestId, list })),
      Effect.catch((error) =>
        Effect.succeed(FailedList({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
  Create: ({ requestId, command }) => ({
    name: "CreateSchoolSurvey",
    args: { requestId },
    effect: client.surveys.createAdminSurvey(command).pipe(
      Effect.map((survey) => SucceededCreate({ requestId, survey })),
      Effect.catch((error) =>
        Effect.succeed(
          FailedCreate({ requestId, commandId: command.commandId, failure: failureFrom(error) }),
        ),
      ),
    ),
  }),
  Close: ({ requestId, command }) => ({
    name: "CloseSchoolSurvey",
    args: { requestId },
    effect: client.surveys.closeAdminSurvey(command).pipe(
      Effect.map((survey) => SucceededClose({ requestId, survey })),
      Effect.catch((error) =>
        Effect.succeed(
          FailedClose({
            requestId,
            commandId: command.commandId,
            surveyId: command.surveyId,
            expectedRevision: command.expectedRevision,
            failure: failureFrom(error),
          }),
        ),
      ),
    ),
  }),
  LoadResults: ({ requestId, surveyId }) => ({
    name: "ReadSchoolSurveyResults",
    args: { requestId, surveyId },
    effect: client.surveys.readAdminResults({ surveyId }).pipe(
      Effect.map((results) => LoadedResults({ requestId, surveyId, results })),
      Effect.catch((error) =>
        Effect.succeed(FailedResults({ requestId, surveyId, failure: failureFrom(error) })),
      ),
    ),
  }),
});
