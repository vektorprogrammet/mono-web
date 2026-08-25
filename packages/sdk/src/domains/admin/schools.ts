import { Effect } from "effect";
import type { InternalSdkError } from "../../errors.js";
import { SchoolsDecodeError } from "../../errors.js";
import {
  SchoolDirectorySchema,
  type AdminSchoolsListInput,
  type SchoolDirectory,
} from "../../schemas/schools.js";
import type { Transport } from "../../transport.js";

const strictSchools = {
  strict: true,
  decodeError: () => new SchoolsDecodeError(),
  errorFamily: "schools",
} as const;

export interface AdminSchoolsDomain {
  /** Reads the complete authorized directory in exactly one native request. */
  readonly list: (
    input?: AdminSchoolsListInput,
  ) => Effect.Effect<SchoolDirectory, InternalSdkError>;
}

export const createAdminSchoolsDomain = (transport: Transport): AdminSchoolsDomain => ({
  list: (input = {}) =>
    transport.get(
      "/api/admin/schools",
      SchoolDirectorySchema,
      input.department === undefined ? undefined : { department: input.department },
      strictSchools,
    ),
});
