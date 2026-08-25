import type {
  AdminSchoolsListInput,
  InternalSdkError,
  SchoolDirectory,
} from "@vektorprogrammet/sdk/effect";
import { apiUrl, createEffectClient } from "@vektorprogrammet/sdk/effect";
import type { Effect } from "effect";

export interface SchoolsDirectoryOperations {
  readonly list: (
    input?: AdminSchoolsListInput,
  ) => Effect.Effect<SchoolDirectory, InternalSdkError>;
}

export interface SchoolsDirectoryClient {
  readonly admin: {
    readonly schools: SchoolsDirectoryOperations;
  };
}

export const createBrowserSchoolsDirectoryClient = (): SchoolsDirectoryClient => {
  const client = createEffectClient(apiUrl);
  return { admin: { schools: client.admin.schools } };
};
