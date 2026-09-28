import type { DepartmentId } from "@vektorprogrammet/domain";
import type {
  NativeRpcClient,
  SchoolCommand,
  SchoolCommandResult,
  SchoolDirectory,
  SchoolManagement,
} from "@vektorprogrammet/rpc";
import { IdempotencyKey } from "@vektorprogrammet/rpc";
import { Effect } from "effect";
import { callBrowserNative, type NativeAnswerInvalid } from "../../lib/browser-native";
import { nativeProblemFrom } from "../../lib/native-problem";
import { schoolsBridgeFailure, type SchoolsBridgeFailure } from "./bridge";

type NativeClient = NativeRpcClient["Service"];

/** The failure of one native RPC call: its declared problems, transport errors, and an invalid answer. */
type RpcFailure<Tag extends keyof NativeClient> =
  | Effect.Error<ReturnType<NativeClient[Tag]>>
  | NativeAnswerInvalid;

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
      RpcFailure<"directory.readSchoolManagement">
    >;
    readonly executeCommand: (
      command: SchoolCommand,
    ) => Effect.Effect<SchoolCommandResult, RpcFailure<"directory.executeSchoolCommand">>;
  };
}

export const createBrowserSchoolsDirectoryClient = (): SchoolsDirectoryClient => ({
  directory: {
    listSchools: (input = {}) =>
      callBrowserNative((client) =>
        client["directory.listSchools"](
          input.department === undefined ? {} : { departmentId: input.department },
        ),
      ).pipe(
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
    readManagement: () => callBrowserNative((client) => client["directory.readSchoolManagement"]()),
    executeCommand: (command) =>
      callBrowserNative((client) =>
        client["directory.executeSchoolCommand"]({
          idempotencyKey: IdempotencyKey.make(command.commandId),
          request: command,
        }),
      ),
  },
});
