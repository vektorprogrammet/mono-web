import * as PgClient from "@effect/sql-pg/PgClient";
import { readFile } from "node:fs/promises";
import { Redacted } from "effect";
import { makeReceiptApiConfig } from "./config.js";
import { makeReceiptApiHttp } from "./http.js";

declare const Bun: {
  serve: (options: {
    readonly hostname: string;
    readonly port: number;
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }) => {
    readonly stop: (closeActiveConnections?: boolean) => Promise<void> | void;
  };
};

const migrationUrl = new URL(
  "../../../packages/domain/src/receipt/migrations/0001-receipt-authority.sql",
  import.meta.url,
);

const config = makeReceiptApiConfig();
const migrationSql = await readFile(migrationUrl, "utf8");
const postgresLayer = PgClient.layer({
  url: Redacted.make(config.postgresUrl),
  applicationName: "receipt-owner-api",
  maxConnections: 8,
});
const api = makeReceiptApiHttp({ config, migrationSql, postgresLayer });

try {
  await api.migrate();
} catch {
  process.stderr.write("receipt-api migration failed\n");
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: api.fetch });
  process.stdout.write(`receipt-api listening on ${config.host}:${config.port}\n`);
  const shutdown = () => {
    void Promise.resolve(server.stop(true)).then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
