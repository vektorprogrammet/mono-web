import { Effect } from "effect";
import { Command } from "foldkit";
import type {
  SocialEventsCreateCommand,
  SocialEventsListInput,
  SocialEventsBridgeFailure,
} from "./bridge";
import type { SocialEventsClient } from "./browser-client";
import {
  FailedCreate,
  FailedList,
  FailedScope,
  LoadedList,
  LoadedScope,
  SucceededCreate,
  type Message,
} from "./message";
import { SocialEventsFailure } from "./model";

export interface SocialEventsCommandFactories {
  readonly LoadScope: (args: { readonly requestId: number }) => Command.Command<Message>;
  readonly LoadList: (args: {
    readonly requestId: number;
    readonly query: SocialEventsListInput;
  }) => Command.Command<Message>;
  readonly Create: (args: {
    readonly requestId: number;
    readonly command: SocialEventsCreateCommand;
  }) => Command.Command<Message>;
}

export const failureFrom = (error: SocialEventsBridgeFailure): SocialEventsFailure => {
  switch (error.error.tag) {
    case "UnauthenticatedActor":
      return SocialEventsFailure.cases.Denied.make({
        tag: "UnauthenticatedActor",
        message: "Økten din er utløpt. Logg inn på nytt.",
      });
    case "NotInScope":
      return SocialEventsFailure.cases.Denied.make({
        tag: "NotInScope",
        message: "Du har ikke tilgang til arrangementene for denne avdelingen.",
      });
    case "InvalidScope":
      return SocialEventsFailure.cases.Failed.make({
        tag: "InvalidScope",
        message: "Den valgte avdelingen eller semesteret er ikke tilgjengelig.",
      });
    case "ValidationFailed":
      return SocialEventsFailure.cases.Failed.make({
        tag: "ValidationFailed",
        message: "Arrangementet kunne ikke lagres. Kontroller feltene og prøv igjen.",
      });
    case "CommandConflict":
      return SocialEventsFailure.cases.Failed.make({
        tag: "CommandConflict",
        message: "Lagringen er allerede behandlet eller pågår. Prøv igjen.",
      });
    case "SocialEventsDecodeError":
      return SocialEventsFailure.cases.Failed.make({
        tag: "SocialEventsDecodeError",
        message: "Arrangementssvaret hadde et ugyldig format.",
      });
    case "Network":
      return SocialEventsFailure.cases.Failed.make({
        tag: "Network",
        message: "Nettverksforbindelsen til arrangementene feilet.",
      });
    case "Configuration":
      return SocialEventsFailure.cases.Failed.make({
        tag: "Configuration",
        message: "Arrangementene er ikke konfigurert.",
      });
    case "SocialEventsPersistenceError":
      return SocialEventsFailure.cases.Failed.make({
        tag: "SocialEventsPersistenceError",
        message: "Arrangementene er midlertidig utilgjengelige.",
      });
  }
};

export const commandsFor = (
  client: SocialEventsClient,
): SocialEventsCommandFactories => ({
  LoadScope: ({ requestId }) => ({
    name: "LoadSocialEventsScope",
    args: { requestId },
    effect: client.socialEvents.readScope.pipe(
      Effect.map((scope) => LoadedScope({ requestId, scope })),
      Effect.catch((error) =>
        Effect.succeed(FailedScope({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
  LoadList: ({ requestId, query }) => ({
    name: "LoadSocialEventsList",
    args: { requestId, query },
    effect: client.socialEvents.list(query).pipe(
      Effect.map((list) => LoadedList({ requestId, list })),
      Effect.catch((error) =>
        Effect.succeed(FailedList({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
  Create: ({ requestId, command }) => ({
    name: "CreateSocialEvent",
    args: { requestId },
    effect: client.socialEvents.create(command).pipe(
      Effect.map(() => SucceededCreate({ requestId })),
      Effect.catch((error) =>
        Effect.succeed(FailedCreate({ requestId, failure: failureFrom(error) })),
      ),
    ),
  }),
});
