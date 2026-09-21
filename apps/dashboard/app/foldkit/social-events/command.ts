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
import type { SocialEventsFailure } from "./model";

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
      return {
        _tag: "Denied",
        tag: "UnauthenticatedActor",
        message: "Økten din er utløpt. Logg inn på nytt.",
      };
    case "NotInScope":
      return {
        _tag: "Denied",
        tag: "NotInScope",
        message: "Du har ikke tilgang til arrangementene for denne avdelingen.",
      };
    case "InvalidScope":
      return {
        _tag: "Failed",
        tag: "InvalidScope",
        message: "Den valgte avdelingen eller semesteret er ikke tilgjengelig.",
      };
    case "ValidationFailed":
      return {
        _tag: "Failed",
        tag: "ValidationFailed",
        message: "Arrangementet kunne ikke lagres. Kontroller feltene og prøv igjen.",
      };
    case "CommandConflict":
      return {
        _tag: "Failed",
        tag: "CommandConflict",
        message: "Lagringen er allerede behandlet eller pågår. Prøv igjen.",
      };
    case "SocialEventsDecodeError":
      return {
        _tag: "Failed",
        tag: "SocialEventsDecodeError",
        message: "Arrangementssvaret hadde et ugyldig format.",
      };
    case "Network":
      return {
        _tag: "Failed",
        tag: "Network",
        message: "Nettverksforbindelsen til arrangementene feilet.",
      };
    case "Configuration":
      return {
        _tag: "Failed",
        tag: "Configuration",
        message: "Arrangementene er ikke konfigurert.",
      };
    case "SocialEventsPersistenceError":
      return {
        _tag: "Failed",
        tag: "SocialEventsPersistenceError",
        message: "Arrangementene er midlertidig utilgjengelige.",
      };
  }
};

export const makeSocialEventsCommands = (
  client: SocialEventsClient,
): SocialEventsCommandFactories => ({
  LoadScope: ({ requestId }) => ({
    name: "LoadSocialEventsScope",
    args: { requestId },
    effect: client.socialEvents.readScope().pipe(
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
