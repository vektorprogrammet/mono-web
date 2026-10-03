import { Context, Effect } from "effect";

/** One converted Web request is supplied only for its current raw-handler invocation. */
export const CurrentRawWebRequest = Context.Reference<Request | undefined>(
  "@vektorprogrammet/backend/http-api/current-raw-web-request",
  { defaultValue: () => undefined },
);

export const currentRawWebRequest = Effect.gen(function* () {
  const request = yield* CurrentRawWebRequest;

  return request === undefined
    ? yield* Effect.die(new TypeError("Native API guard ran outside its raw request"))
    : request;
});
