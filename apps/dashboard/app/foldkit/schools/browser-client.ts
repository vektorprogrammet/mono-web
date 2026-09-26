import type {
  DepartmentId,
  SchoolDirectory,
  SchoolCommand,
  SchoolCommandResult,
  SchoolManagement,
} from "@vektorprogrammet/http-api";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { createEffectClient, type EffectSdkFailure } from "@vektorprogrammet/sdk/effect";
import { Effect } from "effect";
import { resolveBrowserApiUrl } from "../../lib/browser-api";
import { nativeProblemFrom } from "../../lib/native-problem";
import { schoolsBridgeFailure, type SchoolsBridgeFailure } from "./bridge";

export interface SchoolsListInput {
  readonly department?: DepartmentId;
}

export interface SchoolsDirectoryClient {
  readonly directory: {
    readonly listSchools: (
      input?: SchoolsListInput,
    ) => Effect.Effect<SchoolDirectory, SchoolsBridgeFailure>;
    readonly readManagement: () => Effect.Effect<
      SchoolManagement,
      EffectSdkFailure<"directory", "readSchoolManagement">
    >;
    readonly executeCommand: (
      command: SchoolCommand,
    ) => Effect.Effect<SchoolCommandResult, EffectSdkFailure<"directory", "executeSchoolCommand">>;
  };
}

export const createBrowserSchoolsDirectoryClient = (): SchoolsDirectoryClient => {
  const client = createEffectClient(
    resolveBrowserApiUrl(import.meta.env.VITE_API_URL, globalThis.location.origin),
  );

  return {
    directory: {
      listSchools: (input = {}) =>
        client.directory.listSchools({ query: input }).pipe(
          Effect.map(({ body }) => body),
          Effect.mapError((error) => {
            const code = nativeProblemFrom(error)?.code;

            return schoolsBridgeFailure(
              code === "authority.denied"
                ? "NotInScope"
                : code === "credential.invalid" || code === "credential.missing"
                  ? "UnauthenticatedActor"
                  : code === "schools.invalid-department"
                    ? "SchoolsDepartmentNotFound"
                    : "SchoolsPersistenceError",
            );
          }),
        ),
      readManagement: () =>
        client.directory.readSchoolManagement().pipe(Effect.map(({ body }) => body)),
      executeCommand: (command) =>
        client.directory
          .executeSchoolCommand({
            payload: command,
            headers: { "idempotency-key": IdempotencyKey.make(command.commandId) },
          })
          .pipe(Effect.map(({ body }) => body)),
    },
  };
};
