import * as PgClient from "@effect/sql-pg/PgClient";
import { readFile } from "node:fs/promises";
import { Redacted } from "effect";
import { makeAdmissionApiConfig } from "./config.js";
import { makeAdmissionApiHttp } from "./http.js";

declare const Bun: {
  serve: (options: {
    readonly hostname: string;
    readonly port: number;
    readonly fetch: (request: Request) => Response | Promise<Response>;
  }) => {
    readonly stop: (closeActiveConnections?: boolean) => Promise<void> | void;
  };
};

const admissionPeriodMigrationUrl = new URL(
  "../../../packages/domain/src/admission-period/migrations/0001-admission-period-authority.sql",
  import.meta.url,
);
const applicantMigrationUrl = new URL(
  "../../../packages/domain/src/application/migrations/0002-public-applicant-admission.sql",
  import.meta.url,
);

const config = makeAdmissionApiConfig();
const migrationSql = [
  await readFile(admissionPeriodMigrationUrl, "utf8"),
  await readFile(applicantMigrationUrl, "utf8"),
].join("\n");
const postgresLayer = PgClient.layer({
  url: Redacted.make(config.postgresUrl),
  applicationName: "public-applicant-admission-api",
  maxConnections: 8,
});
const api = makeAdmissionApiHttp({ config, migrationSql, postgresLayer });

try {
  await api.migrate();
} catch {
  process.stderr.write("admission-api migration failed\n");
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: api.fetch });
  process.stdout.write(`admission-api listening on ${config.host}:${config.port}\n`);
  const shutdown = () => {
    void Promise.resolve(server.stop(true)).then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
