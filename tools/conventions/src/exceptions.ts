/**
 * The Effect exception registry.
 *
 * `docs/effect-exceptions.json` registers every site that does not follow an Effect rule: a
 * disable comment of an Effect lint rule, a leaking-requirements expectation in a JSDoc block, an
 * Effect diagnostics directive, or a non-native substitute. Each entry records its scope, the
 * capability that the native form lacks, the native alternatives examined, the verification, the
 * module that owns the sites, the package versions it was examined against, and what retires it.
 * Each site names its entry id (EX- and four digits) in a comment. A JSDoc tag reads the rest of
 * its text as service names, so the id sits in the same JSDoc block before the tag.
 *
 * `just exceptions` fails on a suppression without a registered id, on an id that the registry
 * does not list for its file, and on an entry whose rules, files, symbols, owner, or examined
 * versions no longer match the tree. An upgrade of an examined package reopens its entries.
 */
import { Result, Schema } from "effect";
import { parseSync } from "rolldown/utils";
import type { Finding } from "./check.js";
import { type Comment, docLines } from "./constructs.js";
import type { Repository } from "./repository.js";

export const registry = "docs/effect-exceptions.json";

/**
 * The Oxlint plugins whose rules enforce Effect: the Effect language service, the Effect plugin,
 * and the project's Effect rules. A suppression of one of their rules needs a registered entry.
 */
export const effectRulePlugins = ["effecttsgo", "effect", "anti-slop-effect"] as const;

// FX001 to FX016, the shared rule vocabulary of the Effect skills.
const policyRule = /^FX0(?:0[1-9]|1[0-6])$/u;

const toolRule = new RegExp(`^(?:${effectRulePlugins.join("|")})/[a-z0-9]+(?:-[a-z0-9]+)*$`, "u");

const Text = Schema.NonEmptyString;

const EffectException = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^EX-\d{4}$/u)),
  /** The FX rules that the sites depart from, and the tool rules that they suppress. */
  rules: Schema.NonEmptyArray(
    Schema.String.check(
      Schema.makeFilter((rule) => policyRule.test(rule) || toolRule.test(rule), {
        message: "an FX rule (FX001 to FX016) or a rule of an Effect lint plugin",
      }),
    ),
  ),
  scope: Schema.Struct({
    files: Schema.NonEmptyArray(Text),
    symbols: Schema.NonEmptyArray(Text),
  }),
  reason: Text,
  missingCapability: Text,
  nativeAlternatives: Schema.NonEmptyArray(Text),
  verification: Schema.NonEmptyArray(Text),
  /** The module, a directory with an `AGENTS.md` guide, that holds every file of the scope. */
  owner: Text,
  /** Each package whose capability the entry depends on, with the version it was examined against. */
  examinedWith: Schema.Record(Schema.String, Text),
  retirementTrigger: Text,
});

export type EffectException = typeof EffectException.Type;

/** The registry file: what it registers, then the entries. */
export const EffectExceptionRegistry = Schema.fromJsonString(
  Schema.Struct({ description: Text, exceptions: Schema.Array(EffectException) }),
);

const decodeRegistry = Schema.decodeResult(EffectExceptionRegistry, {
  onExcessProperty: "error",
});

const Versions = Schema.Record(Schema.String, Schema.String);

const RootManifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Versions),
    devDependencies: Schema.optional(Versions),
    catalog: Schema.optional(Versions),
    catalogs: Schema.optional(Schema.Record(Schema.String, Versions)),
  }),
);

const decodeRootManifest = Schema.decodeSync(RootManifest);

/** The version that the root `package.json` pins for `name`, directly or through a catalog. */
const pinnedVersion = (manifest: typeof RootManifest.Type, name: string): string | undefined => {
  const declared = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];

  // Workspace packages reach a package that the root does not declare through a catalog.
  if (declared === undefined)
    return (
      manifest.catalog?.[name] ??
      Object.values(manifest.catalogs ?? {}).find((catalog) => Object.hasOwn(catalog, name))?.[name]
    );

  if (!declared.startsWith("catalog:")) return declared;

  const catalog = declared.slice("catalog:".length);

  return catalog === "" ? manifest.catalog?.[name] : manifest.catalogs?.[catalog]?.[name];
};

/** A place in a source file. */
export interface Site {
  readonly path: string;
  readonly line: number;
}

/** A comment that suppresses Effect rules. */
export interface Suppression extends Site {
  /** The directive or tag, such as `oxlint-disable-next-line`. */
  readonly form: string;
  /** The Effect rules it suppresses; none for a directive that suppresses every rule. */
  readonly rules: ReadonlyArray<string>;
  /** The exception ids that the comment names. */
  readonly ids: ReadonlyArray<string>;
  /** Exception ids inside a JSDoc tag, which reads them as service names. */
  readonly misplaced: ReadonlyArray<string>;
}

/** An exception id that a comment names. */
export interface Reference extends Site {
  readonly id: string;
}

export interface Sites {
  readonly suppressions: ReadonlyArray<Suppression>;
  readonly references: ReadonlyArray<Reference>;
}

export interface ExceptionReport extends Sites {
  readonly exceptions: ReadonlyArray<EffectException>;
  readonly findings: ReadonlyArray<Finding>;
}

type Found = Omit<Suppression, "path">;

const exceptionId = /\bEX-\d{4}\b/gu;

const idsIn = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(exceptionId)].map(([id]) => id);

const disableDirective = /^((?:oxlint|eslint)-disable(?:-next-line|-line)?)(?=\s|$)(.*)$/su;

// A directive's description follows two or more dashes between spaces.
const descriptionSeparator = /(?:^|\s)-{2,}(?:\s|$)/u;

/** An Oxlint or ESLint disable directive that names an Effect rule or no rule at all. */
const disableSuppression = (comment: Comment, line: number): ReadonlyArray<Found> => {
  const directive = disableDirective.exec(comment.value.trim());

  if (directive === null) return [];

  const [, form = "", rest = ""] = directive;
  const [ruleList = ""] = rest.split(descriptionSeparator);
  const named = ruleList.split(/[\s,]+/u).filter((rule) => rule !== "");

  const rules = named.filter((rule) =>
    effectRulePlugins.some((plugin) => rule === plugin || rule.startsWith(`${plugin}/`)),
  );

  return named.length > 0 && rules.length === 0
    ? []
    : [{ line, form, rules, ids: idsIn(comment.value), misplaced: [] }];
};

// The tags with which @effect/tsgo accepts a leaked requirement.
const expectationTags = ["@effect-expect-leaking", "@effect-leakable-service"] as const;

/** The leaking-requirements expectations of a JSDoc block, with the ids in each tag's text. */
const expectationSuppressions = (comment: Comment, line: number): ReadonlyArray<Found> => {
  if (comment.type !== "Block" || !comment.value.startsWith("*")) return [];

  const lines = docLines(comment);

  return lines.flatMap((text, index) => {
    const form = expectationTags.find((tag) => text === tag || text.startsWith(`${tag} `));

    if (form === undefined) return [];

    // A tag's text runs to the next tag or the end of the block.
    const next = lines.findIndex((other, later) => later > index && other.startsWith("@"));
    const misplaced = idsIn(lines.slice(index, next === -1 ? undefined : next).join("\n"));

    return [
      {
        line: line + index,
        form,
        rules: ["effecttsgo/leaking-requirements"],
        ids: idsIn(comment.value).filter((id) => !misplaced.includes(id)),
        misplaced,
      },
    ];
  });
};

const diagnosticsDirective = /^(@effect-diagnostics(?:-next-line)?)(?=\s|$)(.*)$/u;

const diagnosticsSetting = /^(?:effect\/)?([A-Za-z]+):([a-z]+)$/u;

/** Effect diagnostics directives, which set the severity of language-service rules in a file. */
const diagnosticsSuppressions = (comment: Comment, line: number): ReadonlyArray<Found> =>
  docLines(comment).flatMap((text, index) => {
    const directive = diagnosticsDirective.exec(text.trim());

    if (directive === null) return [];

    const [, form = "", settings = ""] = directive;

    const lowered = settings.split(/[\s,]+/u).flatMap((setting) => {
      const [, name = "", severity = ""] = diagnosticsSetting.exec(setting) ?? [];

      return name === "" || severity === "error"
        ? []
        : [`effecttsgo/${name.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`];
    });

    // A directive that only raises rules to errors suppresses nothing.
    return settings.trim() !== "" && lowered.length === 0
      ? []
      : [{ line: line + index, form, rules: lowered, ids: idsIn(comment.value), misplaced: [] }];
  });

/** The suppressions of Effect rules and the exception references in the comments of one file. */
export const readSites = (path: string, text: string): Sites => {
  const { comments } = parseSync(path, text);
  const lineStarts = [0, ...[...text.matchAll(/\n/gu)].map((match) => match.index + 1)];
  const lineOf = (offset: number) => lineStarts.findLastIndex((start) => start <= offset) + 1;

  const suppressions = comments.flatMap((comment) => {
    const line = lineOf(comment.start);

    return [
      ...disableSuppression(comment, line),
      ...expectationSuppressions(comment, line),
      ...diagnosticsSuppressions(comment, line),
    ].map((found) => ({ path, ...found }));
  });

  const references = comments.flatMap((comment) =>
    // The value of a comment starts after its two opening characters, `//` or `/*`.
    [...comment.value.matchAll(exceptionId)].map((match) => ({
      path,
      line: lineOf(comment.start + 2 + match.index),
      id: match[0],
    })),
  );

  return { suppressions, references };
};

const sourceFile = /\.(?:[cm]?[jt]sx?)$/u;

// A file without one of these holds no suppression and no reference, so it is not parsed.
const candidate = /-disable|@effect-|EX-\d/u;

const at = (site: Site): string => `${site.path}:${site.line}`;

/** The registered exceptions, or the finding that the registry is missing or does not decode. */
const readRegistry = (repository: Repository): Pick<ExceptionReport, "exceptions" | "findings"> =>
  repository.paths.includes(registry)
    ? Result.match(decodeRegistry(repository.read(registry)), {
        onFailure: (error) => ({
          exceptions: [],
          findings: [{ path: registry, message: `does not decode: ${error.message}` }],
        }),
        onSuccess: (decoded) => ({ exceptions: decoded.exceptions, findings: [] }),
      })
    : {
        exceptions: [],
        findings: [
          {
            path: registry,
            message: "is missing; it registers every suppression of an Effect rule",
          },
        ],
      };

/** The findings of one suppression: it names its rules and a registered exception that lists them. */
const suppressionFindings = (
  suppression: Suppression,
  byId: ReadonlyMap<string, EffectException>,
): ReadonlyArray<Finding> => {
  const { form, rules, ids, misplaced } = suppression;
  const path = at(suppression);

  if (rules.length === 0)
    return [{ path, message: `${form} suppresses every rule; name the rules that it suppresses` }];

  return [
    ...misplaced.map((id) => ({
      path,
      message: `names ${id} inside ${form}, which reads it as a service; name the exception before the tag`,
    })),
    ...(ids.length === 0 && misplaced.length === 0
      ? [
          {
            path,
            message: `${form} suppresses ${rules.join(", ")} without naming its exception. Register the site in ${registry} and name the entry id in this comment`,
          },
        ]
      : []),
    ...ids.flatMap((id) =>
      rules.flatMap((rule) =>
        byId.get(id)?.rules.includes(rule) === false
          ? [{ path, message: `suppresses ${rule}, which ${id} does not list in its rules` }]
          : [],
      ),
    ),
  ];
};

/** The findings of one entry against its sites, the tree, and the versions that package.json pins. */
const entryFindings = (
  repository: Repository,
  exception: EffectException,
  sites: Sites,
  manifest: typeof RootManifest.Type,
): ReadonlyArray<Finding> => {
  const { id, rules, scope, owner, examinedWith } = exception;
  const messages: Array<string> = [];

  const suppressed = new Set(
    // A misplaced id still names the site; its own finding asks to move it.
    sites.suppressions.flatMap((suppression) =>
      suppression.ids.includes(id) || suppression.misplaced.includes(id) ? suppression.rules : [],
    ),
  );

  if (!rules.some((rule) => policyRule.test(rule)))
    messages.push(
      "names no FX rule; name the FX rules (FX001 to FX016) that its sites depart from",
    );

  for (const rule of rules)
    if (toolRule.test(rule) && !suppressed.has(rule))
      messages.push(`lists ${rule}, which none of its sites suppresses; remove it`);

  if (!repository.paths.includes(`${owner}/AGENTS.md`))
    messages.push(
      `names the owner ${owner}, which has no AGENTS.md guide; name the module that holds its files`,
    );

  for (const file of scope.files) {
    if (!file.startsWith(`${owner}/`)) messages.push(`lists ${file} outside its owner ${owner}`);

    if (!repository.paths.includes(file)) messages.push(`lists ${file}, which does not exist`);
    else if (!sites.references.some((reference) => reference.path === file && reference.id === id))
      messages.push(
        `lists ${file}, where no comment names ${id}; name it at the site, or remove the file`,
      );
  }

  const texts = scope.files.flatMap((file) =>
    repository.paths.includes(file) ? [repository.read(file)] : [],
  );

  for (const symbol of scope.symbols) {
    // A symbol is an identifier, which may hold `$`, so it matches between non-identifier characters.
    const identifier = new RegExp(
      `(?<![\\w$])${symbol.replaceAll(/[$.*+?^{}()|[\]\\]/gu, "\\$&")}(?![\\w$])`,
      "u",
    );

    if (!texts.some((text) => identifier.test(text)))
      messages.push(`lists the symbol ${symbol}, which none of its files contains`);
  }

  const examined = Object.entries(examinedWith);

  if (examined.length === 0) messages.push("names no package that it was examined against");

  for (const [name, version] of examined) {
    const current = pinnedVersion(manifest, name);

    if (current === undefined)
      messages.push(`was examined against ${name}, which package.json does not pin`);
    else if (current !== version)
      messages.push(
        `was examined against ${name} ${version}, and package.json pins ${current}. Examine the missing capability in ${current}, then update examinedWith or retire the exception`,
      );
  }

  return messages.map((message) => ({ path: registry, message: `${id} ${message}` }));
};

/** Every suppression of an Effect rule and every exception reference against the registry. */
export const checkExceptions = (repository: Repository): ExceptionReport => {
  const suppressions: Array<Suppression> = [];
  const references: Array<Reference> = [];

  for (const path of repository.paths) {
    if (!sourceFile.test(path) || repository.links.has(path)) continue;

    const text = repository.read(path);

    if (!candidate.test(text)) continue;

    const sites = readSites(path, text);

    suppressions.push(...sites.suppressions);
    references.push(...sites.references);
  }

  const { exceptions, findings: registryFindings } = readRegistry(repository);
  const findings: Array<Finding> = [...registryFindings];
  const byId = new Map<string, EffectException>();

  for (const exception of exceptions) {
    if (byId.has(exception.id))
      findings.push({ path: registry, message: `${exception.id} is registered more than once` });

    byId.set(exception.id, exception);
  }

  for (const suppression of suppressions) findings.push(...suppressionFindings(suppression, byId));

  for (const reference of references) {
    const exception = byId.get(reference.id);

    if (exception === undefined)
      findings.push({
        path: at(reference),
        message: `names ${reference.id}, which ${registry} does not register`,
      });
    else if (!exception.scope.files.includes(reference.path))
      findings.push({
        path: at(reference),
        message: `names ${reference.id}, whose scope does not list this file`,
      });
  }

  const manifest = decodeRootManifest(repository.read("package.json"));

  for (const exception of byId.values())
    findings.push(...entryFindings(repository, exception, { suppressions, references }, manifest));

  return {
    exceptions,
    suppressions,
    references,
    findings: findings.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  };
};
