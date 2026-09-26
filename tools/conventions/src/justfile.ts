/**
 * Reads the recipes of the root justfile through `just --dump`, so the command table and the
 * command mentions follow the parser that runs the recipes.
 */
import { spawnSync } from "node:child_process";
import { Predicate, Schema } from "effect";

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
      }),
    ),
  }),
);

export interface Recipe {
  readonly name: string;
  readonly group: string;
  /** How to call it, such as `just golden <journey>`. */
  readonly usage: string;
  readonly doc: string;
}

export interface Justfile {
  /** Public recipes in `just --list` order: by group, then by name. */
  readonly recipes: ReadonlyArray<Recipe>;
  /** Every recipe and alias name, private ones included. */
  readonly names: ReadonlySet<string>;
}

const byCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const readJustfile = (path: string): Justfile => {
  const result = spawnSync("just", ["--justfile", path, "--dump", "--dump-format", "json"], {
    encoding: "utf8",
  });

  if (result.error !== undefined)
    throw new Error(`just could not run (${result.error.message}); run inside devenv shell`);

  if (result.status !== 0) throw new Error(`just --dump failed: ${result.stderr.trim()}`);

  const dump = Schema.decodeSync(Dump)(result.stdout);

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
