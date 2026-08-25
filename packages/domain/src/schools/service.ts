import { Context, Effect } from "effect";
import type { SchoolsFailure } from "./errors.js";
import type { SchoolDirectoryListInput, SchoolDirectoryPage } from "./schema.js";

export interface SchoolsShape {
  readonly listDirectory: (
    input: SchoolDirectoryListInput,
  ) => Effect.Effect<SchoolDirectoryPage, SchoolsFailure>;
}

export class Schools extends Context.Service<Schools, SchoolsShape>()(
  "@vektorprogrammet/domain/Schools",
) {}
