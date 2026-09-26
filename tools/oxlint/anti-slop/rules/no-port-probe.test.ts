// Run with `node --test`: the Oxlint RuleTester parses through raw transfer, which Bun lacks.
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noPortProbeRule } from "./no-port-probe.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const portProbe = (server: string) => [{ messageId: "portProbe", data: { server } }];

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
  "no-port-probe",
  noPortProbeRule,
  {
    valid: [
      // Negative controls. A kept listener hands out its close function.
      `const start = async () => {
        const server = createServer();
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const { port } = server.address();
        return { port, close: () => new Promise((r) => server.close(r)) };
      };`,
      // Teardown in finally closes a server that served.
      `const serve = async () => {
        server.listen(0, "127.0.0.1");
        const { port } = server.address();
        try {
          await use(port);
        } finally {
          server.close();
        }
      };`,
      // A fixed-port availability check reads no address
      // (apps/dashboard/e2e/run-real-native-schools-directory.mjs).
      `const assertPortAvailable = (port) =>
        new Promise((resolve, reject) => {
          const server = createNetServer();
          server.once("error", () => reject(new Error(\`required port \${port} is already in use\`)));
          server.listen(port, "127.0.0.1", () => server.close(resolve));
        });`,
      // Separate listen and close helpers
      // (tools/verification/completion-receipt-postgres-proof-main.ts).
      `const listen = (server: Server): Promise<number> =>
        new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            if (address === null || Predicate.isString(address)) {
              reject(new Error("loopback receiver did not expose a TCP port"));

              return;
            }

            resolve(address.port);
          });
        });

      const close = (server: Server): Promise<void> =>
        new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));`,
      // The construct's probe of a candidate port reads no address.
      `const free = (port) =>
        new Promise((resolve) => {
          const server = createServer();
          server.once("error", () => resolve(false));
          server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
            server.close(() => resolve(true)),
          );
        });`,
      // The close is on another server than the one that listened and read its address.
      `const swap = async () => {
        const kept = createServer();
        await new Promise((r) => kept.listen(0, "127.0.0.1", r));
        const { port } = kept.address();
        await new Promise((r) => other.close(r));
        return port;
      };`,
      // The server is kept and closed from another function.
      `const open = async () => {
        const server = createServer();
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        servers.push(server);
        return server.address().port;
      };
      const closeAll = () => Promise.all(servers.map((server) => new Promise((r) => server.close(r))));`,
      // Exit hooks start their own flow.
      `const keep = () => {
        const server = createServer();
        server.listen(0);
        const { port } = server.address();
        process.on("exit", () => server.close());
        return port;
      };`,
    ],
    invalid: [
      // tools/acceptance/recommendation-check.ts.
      {
        code: `const port = async (preferred = 0) => {
          const s = createServer();
          await new Promise<void>((yes, no) => {
            s.once("error", no);
            s.listen(preferred, "127.0.0.1", yes);
          });
          const a = s.address();
          assert.ok(a && !Predicate.isString(a));
          await new Promise<void>((yes) => s.close(() => yes()));

          return a.port;
        };`,
        errors: portProbe("s"),
      },
      // tools/verification/identity-cohort-rehearsal.ts.
      {
        code: `const freePort = async () => {
          const s = createServer();
          await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
          const address = s.address();
          assert.ok(address !== null && !Predicate.isString(address));
          const p = address.port;
          await new Promise<void>((r) => s.close(() => r()));

          return p;
        };`,
        errors: portProbe("s"),
      },
      // tools/postgres/index.ts: the listen callback belongs to the flow through `server.listen`.
      {
        code: `const freeLoopbackPort = (): Promise<number> => {
          const { promise, resolve, reject } = Promise.withResolvers<number>();
          const server = createServer();
          server.once("error", reject);
          server.listen({ host: loopback, port: 0, exclusive: true }, () => {
            const address = server.address();

            if (address === null || Predicate.isString(address)) {
              server.close();
              reject(new Error("failed to allocate a loopback port for PostgreSQL"));

              return;
            }

            server.close((cause) => {
              if (cause === undefined) resolve(address.port);
              else reject(cause);
            });
          });

          return promise;
        };`,
        errors: portProbe("server"),
      },
      // tools/e2e/golden-harness.ts: the probe runs inside Effect.callback.
      {
        code: `const bindLoopback = (port: number) =>
          Effect.callback<number, HarnessFailure>((resume) => {
            const server = createTcpServer();

            server.once("error", (cause) =>
              resume(
                Effect.fail(
                  new HarnessFailure({ stage: "ports", message: \`127.0.0.1:\${port}: \${cause.message}\` }),
                ),
              ),
            );
            server.listen(port, "127.0.0.1", () => {
              const bound = Schema.decodeUnknownSync(TcpAddress)(server.address()).port;

              server.close(() => resume(Effect.succeed(bound)));
            });
          });`,
        errors: portProbe("server"),
      },
      // tools/e2e/golden-reimbursement.mjs.
      {
        code: `const reservePort = async (requested = 0) => {
          const server = createServer();
          const ready = Promise.withResolvers();
          server.once("error", ready.reject);
          server.listen(requested, "127.0.0.1", ready.resolve);
          await ready.promise;
          const port = server.address().port;
          const closed = Promise.withResolvers();
          server.close((error) => (error ? closed.reject(error) : closed.resolve()));
          await closed.promise;

          return port;
        };`,
        errors: portProbe("server"),
      },
      // tools/verification/unattended-delivery-recovery.ts.
      {
        code: `const port = async (requested = 0) => {
          const server = createServer();
          const listening = Promise.withResolvers<void>();
          server.once("error", listening.reject);
          server.listen(requested, "127.0.0.1", listening.resolve);
          await listening.promise;
          const address = server.address();
          assert.ok(address && !Predicate.isString(address));
          const closed = Promise.withResolvers<void>();
          server.close(() => closed.resolve());
          await closed.promise;

          return address.port;
        };`,
        errors: portProbe("server"),
      },
    ],
  },
);
