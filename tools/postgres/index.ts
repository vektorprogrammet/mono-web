/**
 * PostgreSQL for disposable clusters in tests, proofs, journeys, and CI.
 *
 * The root manifest declares the supported PostgreSQL majors once, as
 * `engines.postgresql` (for example `"17 || 18"`). The highest one is the default.
 * `VEKTOR_POSTGRES_MAJOR` selects another supported major; `devenv shell` reads the
 * same variable and puts the programs of the selected major on `PATH`.
 * Resolution uses the first `postgres` on `PATH` and rejects any other major.
 * Disposable containers use `compose.yml`, which reads the selected major from
 * `VEKTOR_POSTGRES_MAJOR`.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";

const separator = " || ";

/** `engines.postgresql`: distinct majors joined by `" || "`, such as `"17 || 18"`. */
const PostgresMajorSet = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[1-9][0-9]*(?: \|\| [1-9][0-9]*)*$/u),
    Schema.makeFilter(
      (value) => new Set(value.split(separator)).size === value.split(separator).length,
      { message: "distinct PostgreSQL majors" },
    ),
  ),
);

const RootManifest = Schema.fromJsonString(
  Schema.Struct({ engines: Schema.Struct({ postgresql: PostgresMajorSet }) }),
);

/** Decodes an `engines.postgresql` value into its majors, ascending. Throws on a malformed value. */
export const decodePostgresMajors = (declared: string): ReadonlyArray<number> =>
  Schema.decodeSync(PostgresMajorSet)(declared)
    .split(separator)
    .map(Number)
    .toSorted((left, right) => left - right);

/**
 * The major that `requested` (the value of `VEKTOR_POSTGRES_MAJOR`) selects from `supported`.
 * No value, or an empty one, selects the highest. Throws on a major outside `supported`.
 */
export const selectPostgresMajor = (
  supported: ReadonlyArray<number>,
  requested: string | undefined,
): number => {
  if (requested === undefined || requested === "") return Math.max(...supported);

  const major = supported.find((candidate) => String(candidate) === requested);

  if (major !== undefined) return major;

  throw new Error(
    `VEKTOR_POSTGRES_MAJOR=${requested} is not a supported PostgreSQL major. ` +
      `package.json engines.postgresql supports ${supported.join(separator)}.`,
  );
};

/** The PostgreSQL majors that the root manifest supports, ascending. */
export const supportedPostgresMajors = decodePostgresMajors(
  Schema.decodeSync(RootManifest)(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).engines.postgresql,
);

/** The highest supported major, which runs when `VEKTOR_POSTGRES_MAJOR` is unset. */
export const defaultPostgresMajor = selectPostgresMajor(supportedPostgresMajors, undefined);

/** The major that `VEKTOR_POSTGRES_MAJOR` selects, or the default. */
export const selectedPostgresMajor = selectPostgresMajor(
  supportedPostgresMajors,
  process.env.VEKTOR_POSTGRES_MAJOR,
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

  if (directory !== undefined && major === selectedPostgresMajor) return directory;

  throw new Error(
    `PostgreSQL ${selectedPostgresMajor} (selected by VEKTOR_POSTGRES_MAJOR from package.json ` +
      `engines.postgresql ${supportedPostgresMajors.join(separator)}) is required on PATH, which provides ` +
      `${directory === undefined ? "no postgres" : `${directory}/postgres (${major ?? "unknown version"})`}. ` +
      "Run the command inside `devenv shell` with the same VEKTOR_POSTGRES_MAJOR, which provides it.",
  );
};

let binDirectory: string | undefined;

/** Absolute path of a program of the selected PostgreSQL major. */
export const postgresProgram = (program: PostgresProgram): string =>
  join((binDirectory ??= resolveBinDirectory()), program);

/** Compose file of the disposable `receipt-postgres` container. */
export const postgresComposeFile = fileURLToPath(new URL("./compose.yml", import.meta.url));

/** Compose interpolates the image on every command, so each one needs the selected major. */
export const postgresComposeEnvironment = <
  Environment extends Readonly<Record<string, string | undefined>>,
>(
  environment: Environment,
): Environment & { readonly VEKTOR_POSTGRES_MAJOR: string } => ({
  ...environment,
  VEKTOR_POSTGRES_MAJOR: String(selectedPostgresMajor),
});
