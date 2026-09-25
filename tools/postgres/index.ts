/**
 * PostgreSQL for disposable clusters in tests, proofs, journeys, and CI.
 *
 * The root manifest declares the PostgreSQL major once, as `engines.postgresql`.
 * Programs of that major resolve from `PATH`, or else from
 * `nixpkgs#postgresql_<major>`. Resolution never falls back to another major.
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

const nixBinDirectory = () => {
  const result = spawnSync(
    "nix",
    [
      "--extra-experimental-features",
      "nix-command flakes",
      "build",
      "--no-link",
      "--print-out-paths",
      `nixpkgs#postgresql_${postgresMajor}^out`,
    ],
    { encoding: "utf8" },
  );

  return result.status === 0 ? join(result.stdout.trim(), "bin") : undefined;
};

const resolveBinDirectory = () => {
  const mismatches: Array<string> = [];

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "" || !executable(join(directory, "postgres"))) continue;

    const major = majorOf(join(directory, "postgres"));

    if (major === postgresMajor) return directory;

    mismatches.push(`${directory} (${major ?? "unknown version"})`);
  }

  const nix = nixBinDirectory();

  if (nix !== undefined && majorOf(join(nix, "postgres")) === postgresMajor) return nix;

  throw new Error(
    `PostgreSQL ${postgresMajor} (package.json engines.postgresql) is required. ` +
      `PATH provides ${mismatches.length === 0 ? "no postgres" : mismatches.join(", ")}, ` +
      `and nixpkgs#postgresql_${postgresMajor} is unavailable. ` +
      `Put the bin directory of PostgreSQL ${postgresMajor} on PATH.`,
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
