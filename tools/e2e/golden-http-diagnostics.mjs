// Golden-only preload. Record transport metadata, never headers, query strings, or bodies.
import { Console, Data, Effect } from "effect";

// The wrapped handler failed; Bun receives its original error.
class HandlerFailure extends Data.TaggedError("HandlerFailure") {}

const serve = Bun.serve.bind(Bun);

let sequence = 0;

Bun.serve = (options) => {
  const fetch = options.fetch;

  return serve({
    ...options,
    // Bun calls the handler for a Response; each request runs its record program to completion.
    fetch: (request, server) => {
      const started = performance.now();

      const identity = {
        diagnostic: "golden-http",
        pid: process.pid,
        sequence: ++sequence,
        method: request.method,
        path: new URL(request.url).pathname,
      };

      const record = (event, fields = {}) =>
        Console.log(
          JSON.stringify({
            ...identity,
            event,
            elapsed_ms: Math.round(performance.now() - started),
            ...fields,
          }),
        );

      const abort = () => Effect.runSync(record("aborted"));
      request.signal.addEventListener("abort", abort, { once: true });

      return Effect.runPromise(
        record("started").pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: () => Promise.resolve(fetch(request, server)),
              catch: (cause) => new HandlerFailure({ cause }),
            }),
          ),
          Effect.tap((response) => record("response", { status: response.status })),
          Effect.tapError(() => record("failed")),
          Effect.catchTag("HandlerFailure", (failure) => Effect.die(failure.cause)),
          Effect.ensuring(Effect.sync(() => request.signal.removeEventListener("abort", abort))),
        ),
      );
    },
  });
};
