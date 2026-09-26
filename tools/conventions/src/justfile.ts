/**
 * Reads the recipes of the root justfile through `just --dump`, so the command table, the command
 * mentions, and the journey sets follow the parser that runs the recipes.
 */
import { spawnSync } from "node:child_process";
import { Predicate, Schema } from "effect";

// A body line is text and `{{…}}` interpolations; the dump gives an interpolation as an array.
const Fragment = Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]);

const Dump = Schema.fromJsonString(
  Schema.Struct({
    aliases: Schema.Record(Schema.String, Schema.Struct({ target: Schema.String })),
    recipes: Schema.Record(
      Schema.String,
      Schema.Struct({
        name: Schema.String,
        doc: Schema.NullOr(Schema.String),
        private: Schema.Boolean,
        attributes: Schema.Array(
          Schema.Union([Schema.String, Schema.Struct({ group: Schema.optional(Schema.String) })]),
        ),
        parameters: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            kind: Schema.Literals(["singular", "plus", "star"]),
            default: Schema.Unknown,
          }),
        ),
        body: Schema.Array(Schema.Array(Fragment)),
      }),
    ),
  }),
);

/** A branch of a `case` statement. */
export interface CaseBranch {
  /** The patterns between the `|` separators, such as `school-service` and `recruitment`. */
  readonly patterns: ReadonlyArray<string>;
  /** The commands of the branch on one line, without the closing `;;`. */
  readonly command: string;
}

/** A `case` statement of a recipe body. */
export interface CaseStatement {
  /** The word that the statement matches, without quotes, such as `$1`. */
  readonly subject: string;
  /** The branches in order, without the `*)` branch. */
  readonly branches: ReadonlyArray<CaseBranch>;
  /** The command of the `*)` branch, which handles every other word, if the statement has one. */
  readonly otherwise: string | undefined;
}

export interface Recipe {
  readonly name: string;
  readonly group: string;
  /** How to call it, such as `just golden <journey>`. */
  readonly usage: string;
  readonly doc: string;
  /** The `case` statements of the body, in order. */
  readonly cases: ReadonlyArray<CaseStatement>;
}

const caseStart = /^\s*case\s+(\S+)\s+in\s*$/u;

const caseEnd = /^\s*esac\s*$/u;

const caseBranch = /^\(?([^()]*)\)([\s\S]*)$/u;

// A branch ends at `;;`. Nested `case` statements and `;&` fall-through are not read.
const readCases = (lines: ReadonlyArray<string>): ReadonlyArray<CaseStatement> =>
  lines.flatMap((line, start) => {
    const subject = caseStart.exec(line)?.[1];

    if (subject === undefined) return [];

    const stop = lines.findIndex((candidate, index) => index > start && caseEnd.test(candidate));

    const branches = lines
      .slice(start + 1, stop === -1 ? lines.length : stop)
      .join("\n")
      .split(";;")
      .flatMap((text) => {
        const [, patterns = "", command = ""] = caseBranch.exec(text.trim()) ?? [];

        return patterns === ""
          ? []
          : [
              {
                patterns: patterns.split("|").map((pattern) => pattern.trim()),
                command: command.replaceAll(/\s+/gu, " ").trim(),
              },
            ];
      });

    const otherwise = branches.find((branch) => branch.patterns.join("|") === "*");

    return [
      {
        subject: subject.replace(/^"(.*)"$/u, "$1"),
        branches: branches.filter((branch) => branch !== otherwise),
        otherwise: otherwise?.command,
      },
    ];
  });

export interface Justfile {
  /** Public recipes in `just --list` order: by group, then by name. */
  readonly recipes: ReadonlyArray<Recipe>;
  /** Every recipe and alias name, private ones included. */
  readonly names: ReadonlySet<string>;
}

const byCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** The JSON dump of the justfile at `path`, as `just --dump --dump-format json` prints it. */
export const dumpJustfile = (path: string): string => {
  const result = spawnSync("just", ["--justfile", path, "--dump", "--dump-format", "json"], {
    encoding: "utf8",
  });

  if (result.error !== undefined)
    throw new Error(`just could not run (${result.error.message}); run inside devenv shell`);

  if (result.status !== 0) throw new Error(`just --dump failed: ${result.stderr.trim()}`);

  return result.stdout;
};

/** The recipes of a justfile dump. */
export const decodeJustfile = (text: string): Justfile => {
  const dump = Schema.decodeSync(Dump)(text);

  const recipes = Object.values(dump.recipes)
    .flatMap((recipe) =>
      recipe.private
        ? []
        : [
            {
              name: recipe.name,
              group:
                recipe.attributes.flatMap((attribute) =>
                  Predicate.isString(attribute) || attribute.group === undefined
                    ? []
                    : [attribute.group],
                )[0] ?? "",
              usage: [
                "just",
                recipe.name,
                ...recipe.parameters.map(({ name, kind, default: fallback }) =>
                  kind === "plus"
                    ? `<${name}...>`
                    : kind === "star"
                      ? `[${name}...]`
                      : fallback === null
                        ? `<${name}>`
                        : `[${name}]`,
                ),
              ].join(" "),
              doc: recipe.doc ?? "",
              cases: readCases(
                recipe.body.map((line) =>
                  line
                    .map((fragment) => (Predicate.isString(fragment) ? fragment : "{{…}}"))
                    .join(""),
                ),
              ),
            },
          ],
    )
    .sort(
      (left, right) => byCodeUnits(left.group, right.group) || byCodeUnits(left.name, right.name),
    );

  return {
    recipes,
    names: new Set([...Object.keys(dump.recipes), ...Object.keys(dump.aliases)]),
  };
};

export const readJustfile = (path: string): Justfile => decodeJustfile(dumpJustfile(path));
