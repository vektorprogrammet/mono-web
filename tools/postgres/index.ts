/**
 * PostgreSQL for disposable clusters in tests, proofs, journeys, and CI.
 *
 * The root manifest declares the PostgreSQL major once, as `engines.postgresql`.
 * `devenv shell` puts the programs of that major on `PATH`. Resolution uses the
 * first `postgres` on `PATH` and rejects any other major.
 * Disposable containers use `compose.yml`, which reads the same major from
 * `VEKTOR_POSTGRES_MAJOR`.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const RootManifest = Schema.fromJsonString(
  Schema.Struct({
    engines: Schema.Struct({
      postgresql: Schema.String.pipe(Schema.check(Schema.isPattern(/^[1-9][0-9]*$/u))),
    }),
  }),
);

/** The PostgreSQL major that the root manifest declares. */
export const postgresMajor = Number(
  Schema.decodeSync(RootManifest)(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).engines.postgresql,
);

/** PostgreSQL programs that tests, proofs, and journeys start. */
export type PostgresProgram =
  | "createdb"
  | "initdb"
  | "pg_ctl"
  | "pg_dump"
  | "pg_isready"
  | "pg_restore"
  | "postgres"
  | "psql";

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

const majorOf = (postgres: string) => {
  const result = spawnSync(postgres, ["--version"], { encoding: "utf8" });
  const version = result.error === undefined ? /\(PostgreSQL\) (\d+)/u.exec(result.stdout) : null;

  return version?.[1] === undefined ? undefined : Number(version[1]);
};

const resolveBinDirectory = () => {
  const directory = (process.env.PATH ?? "")
    .split(delimiter)
    .find((entry) => entry !== "" && executable(join(entry, "postgres")));

  const major = directory === undefined ? undefined : majorOf(join(directory, "postgres"));

  if (directory !== undefined && major === postgresMajor) return directory;

  throw new Error(
    `PostgreSQL ${postgresMajor} (package.json engines.postgresql) is required on PATH, which provides ` +
      `${directory === undefined ? "no postgres" : `${directory}/postgres (${major ?? "unknown version"})`}. ` +
      "Run the command inside `devenv shell`, which provides it.",
  );
};

let binDirectory: string | undefined;

/** Absolute path of a program of the declared PostgreSQL major. */
export const postgresProgram = (program: PostgresProgram): string =>
  join((binDirectory ??= resolveBinDirectory()), program);

/** Compose file of the disposable `receipt-postgres` container. */
export const postgresComposeFile = fileURLToPath(new URL("./compose.yml", import.meta.url));

/** Compose interpolates the image on every command, so each one needs the declared major. */
export const postgresComposeEnvironment = <
  Environment extends Readonly<Record<string, string | undefined>>,
>(
  environment: Environment,
): Environment & { readonly VEKTOR_POSTGRES_MAJOR: string } => ({
  ...environment,
  VEKTOR_POSTGRES_MAJOR: String(postgresMajor),
});
