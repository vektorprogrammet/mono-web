import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { toSdkError, type InternalSdkError } from "../errors.js";
import type { FetchCapability } from "../transport.js";

/**
 * Closes SDK Effects at the default package's Promise adapter boundary.
 * Internal typed failures are lowered to the public Promise error contract here.
 */
export const executeSdkPromise = <A>(
  program: Effect.Effect<A, InternalSdkError>,
  fetch: FetchCapability = FetchHttpClient.Fetch.defaultValue(),
): Promise<A> =>
  program.pipe(
    Effect.provideService(FetchHttpClient.Fetch, fetch),
    Effect.mapError(toSdkError),
    Effect.runPromise,
  );
