import { Effect, Layer } from "effect";
import { Database } from "../service.js";
import { listSchoolDirectoryPostgres } from "./postgres.js";
import {
  readSchoolManagement,
  authorizeSchoolCommand,
  executeSchoolCommand,
} from "./administration.js";
import { Schools } from "@vektorprogrammet/domain/schools";

/** Live Schools authority; it reuses the process Database and constructs no runtime. */
export const SchoolsLive: Layer.Layer<Schools, never, Database> = Layer.effect(
  Schools,
  Effect.gen(function* () {
    const database = yield* Database;

    return Schools.of({
      readManagement: (personId) =>
        readSchoolManagement(personId).pipe(Effect.provideService(Database, database)),
      authorizeCommand: (command, personId) =>
        authorizeSchoolCommand(command, personId).pipe(Effect.provideService(Database, database)),
      executeCommand: (command, personId) =>
        executeSchoolCommand(command, personId).pipe(Effect.provideService(Database, database)),
      listDirectory: (input) =>
        listSchoolDirectoryPostgres(input).pipe(Effect.provideService(Database, database)),
    });
  }),
);
