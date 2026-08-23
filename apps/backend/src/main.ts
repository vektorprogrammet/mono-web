import { DatabaseLive } from "@vektorprogrammet/database";
import { Admissions, AdmissionsLive } from "@vektorprogrammet/domain/admissions";
import { databaseHealth, type Database } from "@vektorprogrammet/domain/database";
import { Economy } from "@vektorprogrammet/domain/receipt";
import { EconomyLive } from "@vektorprogrammet/domain/receipt/postgres";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { makeBackendConfig } from "./config.js";
import { makeBackendHttp } from "./router.js";

declare const Bun: {
  serve: (options: {
    readonly hostname: string;
    readonly port: number;
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }) => {
    readonly stop: (closeActiveConnections?: boolean) => Promise<void> | void;
  };
};

const config = makeBackendConfig();
const databaseLayer = DatabaseLive({
  url: Redacted.make(config.postgresUrl),
  applicationName: "vektorprogrammet-backend",
  maxConnections: 8,
});
const capabilityLayers = Layer.merge(AdmissionsLive, EconomyLive).pipe(
  Layer.provide(databaseLayer),
);
const runtime = ManagedRuntime.make(Layer.merge(databaseLayer, capabilityLayers));
const run = <A, E>(effect: Effect.Effect<A, E, Database | Admissions | Economy>): Promise<A> =>
  runtime.runPromise(effect);
const api = makeBackendHttp(config, run);

try {
  await run(databaseHealth);
} catch {
  process.stderr.write("backend database initialization failed\n");
  process.exitCode = 1;
  try {
    await runtime.dispose();
  } catch {
    process.stderr.write("backend runtime disposal failed\n");
  }
}

if (process.exitCode !== 1) {
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: api.fetch });
  process.stdout.write(`backend listening on ${config.host}:${config.port}\n`);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= (async () => {
      let exitCode = 0;
      try {
        await server.stop(true);
      } catch {
        exitCode = 1;
      }
      try {
        await runtime.dispose();
      } catch {
        exitCode = 1;
      }
      process.exitCode = exitCode;
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
