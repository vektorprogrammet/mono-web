// Golden-only preload. Record transport metadata, never headers, query strings, or bodies.
const serve = Bun.serve.bind(Bun);

let sequence = 0;

Bun.serve = (options) => {
  const fetch = options.fetch;

  return serve({
    ...options,
    fetch: async (request, server) => {
      const started = performance.now();

      const identity = {
        diagnostic: "golden-http",
        pid: process.pid,
        sequence: ++sequence,
        method: request.method,
        path: new URL(request.url).pathname,
      };

      const record = (event, fields = {}) =>
        console.log(
          JSON.stringify({
            ...identity,
            event,
            elapsed_ms: Math.round(performance.now() - started),
            ...fields,
          }),
        );

      const abort = () => record("aborted");
      request.signal.addEventListener("abort", abort, { once: true });
      record("started");

      try {
        const response = await fetch(request, server);
        record("response", { status: response.status });

        return response;
      } catch (error) {
        record("failed");
        throw error;
      } finally {
        request.signal.removeEventListener("abort", abort);
      }
    },
  });
};
