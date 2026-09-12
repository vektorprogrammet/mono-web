import { Effect, Layer } from "effect";
import { Database } from "../database/service.js";
import { ReturningAssistants } from "./returning.js";
import {
  preflightReturningAssistantRegistration,
  readReturningAssistantOptions,
  registerReturningAssistant,
} from "./returning-postgres.js";
export const ReturningAssistantsLive = Layer.effect(
  ReturningAssistants,
  Effect.gen(function* () {
    const database = yield* Database;
    return ReturningAssistants.of({
      readOptions: (input) =>
        readReturningAssistantOptions(input).pipe(Effect.provideService(Database, database)),
      preflight: (input, context) =>
        preflightReturningAssistantRegistration(input, context).pipe(
          Effect.provideService(Database, database),
        ),
      register: (input, context) =>
        registerReturningAssistant(input, context).pipe(Effect.provideService(Database, database)),
    });
  }),
);
