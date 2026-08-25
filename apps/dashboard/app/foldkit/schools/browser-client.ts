import {
  Configuration,
  Network,
  SchoolDirectorySchema,
  SchoolsAuthorityInactive,
  SchoolsDecodeError,
  SchoolsDepartmentNotFound,
  SchoolsDepartmentOutOfScope,
  SchoolsNotInScope,
  SchoolsPersistenceError,
  SchoolsUnauthenticatedActor,
  type AdminSchoolsListInput,
  type InternalSdkError,
  type SchoolDirectory,
} from "@vektorprogrammet/sdk/effect";
import { Effect, Schema as S } from "effect";
import { SchoolsBridgeFailureSchema } from "./bridge";

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

const failureFromTag = (
  tag: S.Schema.Type<typeof SchoolsBridgeFailureSchema>["error"]["tag"],
): InternalSdkError => {
  switch (tag) {
    case "UnauthenticatedActor":
      return new SchoolsUnauthenticatedActor();
    case "AuthorityInactive":
      return new SchoolsAuthorityInactive();
    case "NotInScope":
      return new SchoolsNotInScope();
    case "SchoolsDepartmentNotFound":
      return new SchoolsDepartmentNotFound();
    case "SchoolsDepartmentOutOfScope":
      return new SchoolsDepartmentOutOfScope();
    case "SchoolsDecodeError":
      return new SchoolsDecodeError();
    case "SchoolsPersistenceError":
      return new SchoolsPersistenceError();
    case "Configuration":
      return new Configuration({ message: "Schools bridge is not configured" });
    case "Network":
      return new Network({ message: "Schools bridge is unavailable" });
  }
};

const readBridge = async (input: AdminSchoolsListInput, signal: AbortSignal): Promise<Response> => {
  const search = new URLSearchParams();
  if (input.department !== undefined) search.set("department", input.department);
  const query = search.size === 0 ? "" : `?${search.toString()}`;
  return fetch(`/schools${query}`, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
};

const listDirectory = (
  input: AdminSchoolsListInput = {},
): Effect.Effect<SchoolDirectory, InternalSdkError> =>
  Effect.tryPromise({
    try: (signal) => readBridge(input, signal),
    catch: (cause) => new Network({ message: "Schools bridge request failed", cause }),
  }).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () => new SchoolsDecodeError(),
      }).pipe(Effect.map((payload) => ({ response, payload }))),
    ),
    Effect.flatMap(({ response, payload }) => {
      if (response.ok) {
        return S.decodeUnknownEffect(SchoolDirectorySchema)(payload, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new SchoolsDecodeError()));
      }
      return S.decodeUnknownEffect(SchoolsBridgeFailureSchema)(payload, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(() => new SchoolsDecodeError()),
        Effect.flatMap((failure) => Effect.fail(failureFromTag(failure.error.tag))),
      );
    }),
  );

export const createBrowserSchoolsDirectoryClient = (): SchoolsDirectoryClient => ({
  admin: { schools: { list: listDirectory } },
});
