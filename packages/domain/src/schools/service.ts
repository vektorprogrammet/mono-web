import { Context, Effect } from "effect";
import type { SchoolsFailure } from "./errors.js";
import type { SchoolDirectory, SchoolDirectoryListInput } from "./schema.js";

export interface SchoolsShape {
  readonly listDirectory: (
    input: SchoolDirectoryListInput,
  ) => Effect.Effect<SchoolDirectory, SchoolsFailure>;
}

export class Schools extends Context.Service<Schools, SchoolsShape>()(
  "@vektorprogrammet/domain/Schools",
) {}
