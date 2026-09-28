import { Context, Effect } from "effect";
import type { SchoolsFailure } from "./errors.js";
import type { SchoolDirectory, SchoolDirectoryListInput } from "./schema.js";
import type { PersonId } from "../organization/schema.js";
import type {
  SchoolCommand,
  SchoolCommandAuthorization,
  SchoolCommandResult,
  SchoolManagement,
  SchoolCommandFailure,
} from "./administration.js";

export interface SchoolsOperations {
  readonly readManagement: (
    personId: PersonId,
  ) => Effect.Effect<SchoolManagement, SchoolsFailure | SchoolCommandFailure>;
  /** Resolves current authority for one command, with its locks, on the caller's transaction. */
  readonly authorizeCommand: (
    command: SchoolCommand,
    personId: PersonId,
  ) => Effect.Effect<SchoolCommandAuthorization, SchoolsFailure | SchoolCommandFailure>;
  /** Runs the authorized command in the transaction that authorized it. */
  readonly executeCommand: (
    authorization: SchoolCommandAuthorization,
  ) => Effect.Effect<SchoolCommandResult, SchoolsFailure | SchoolCommandFailure>;
  readonly listDirectory: (
    input: SchoolDirectoryListInput,
  ) => Effect.Effect<SchoolDirectory, SchoolsFailure>;
}

export class Schools extends Context.Service<Schools, SchoolsOperations>()(
  "@vektorprogrammet/domain/schools/service/Schools",
) {}
