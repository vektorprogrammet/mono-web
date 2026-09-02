import type { DepartmentId } from "@vektorprogrammet/domain/organization";
import { SchoolDirectorySchema, type SchoolDirectory } from "@vektorprogrammet/domain/schools";
import { Effect, Schema as S } from "effect";
import {
  SchoolsBridgeFailureSchema,
  schoolsBridgeFailure,
  type SchoolsBridgeFailure,
} from "./bridge";

export interface SchoolsListInput {
  readonly department?: DepartmentId;
}

export interface SchoolsDirectoryOperations {
  readonly listSchools: (
    input?: SchoolsListInput,
  ) => Effect.Effect<SchoolDirectory, SchoolsBridgeFailure>;
}

export interface SchoolsDirectoryClient {
  readonly directory: SchoolsDirectoryOperations;
}

const readBridge = async (input: SchoolsListInput, signal: AbortSignal): Promise<Response> => {
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

const listSchools = (
  input: SchoolsListInput = {},
): Effect.Effect<SchoolDirectory, SchoolsBridgeFailure> =>
  Effect.tryPromise({
    try: (signal) => readBridge(input, signal),
    catch: () => schoolsBridgeFailure("Network"),
  }).pipe(
    Effect.flatMap((response) =>
      Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: () => schoolsBridgeFailure("SchoolsDecodeError"),
      }).pipe(Effect.map((payload) => ({ response, payload }))),
    ),
    Effect.flatMap(({ response, payload }) => {
      if (response.ok) {
        return S.decodeUnknownEffect(SchoolDirectorySchema)(payload, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => schoolsBridgeFailure("SchoolsDecodeError")));
      }
      return S.decodeUnknownEffect(SchoolsBridgeFailureSchema)(payload, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(() => schoolsBridgeFailure("SchoolsDecodeError")),
        Effect.flatMap(Effect.fail),
      );
    }),
  );

export const createBrowserSchoolsDirectoryClient = (): SchoolsDirectoryClient => ({
  directory: { listSchools },
});
