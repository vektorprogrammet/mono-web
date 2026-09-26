/**
 * The import graph of the repository's TypeScript and JavaScript modules.
 *
 * Rolldown's build of the Oxc parser reads the static imports, exports, and re-exports of each
 * module. The resolver follows relative paths, the `exports` of workspace packages under the
 * `@vektorprogrammet/source` condition, and the `paths` of a package's `tsconfig.json`. An import
 * resolves to the module that declares the binding, through any chain of re-exports, so a barrel
 * never counts as the owner of what it forwards. Dynamic imports and `require` calls do not count.
 */
import { posix } from "node:path";
import { Predicate, Schema } from "effect";
import { parseSync } from "rolldown/utils";
import { packageDirectories } from "./layout.js";
import type { Repository } from "./repository.js";

/** A name that a module exports, or `default`. */
export interface Binding {
  readonly path: string;
  readonly name: string;
}

/** One imported name: `*` stands for the namespace of the module that `specifier` names. */
export interface Import {
  readonly specifier: string;
  readonly name: string;
}

export interface Module {
  readonly path: string;
  /** Exported names that the module declares, each with the local name of its declaration. */
  readonly locals: ReadonlyMap<string, string>;
  /** Exported names that the module forwards from another module. */
  readonly forwards: ReadonlyMap<string, Import>;
  /** The specifiers of `export * from`, in source order. */
  readonly stars: ReadonlyArray<string>;
  /** Imported names; a namespace import contributes the members that the module reads. */
  readonly imports: ReadonlyArray<Import>;
  /** Parse errors. A module with errors may list too few imports and exports. */
  readonly errors: ReadonlyArray<string>;
}

export interface ModuleGraph {
  readonly modules: ReadonlyMap<string, Module>;
  /** The module that `specifier` names from `importer`, when it is a module of the repository. */
  readonly resolve: (importer: string, specifier: string) => string | undefined;
  /** The module and local export that declare what `binding` names, through re-exports. */
  readonly origin: (binding: Binding) => Binding | undefined;
  /** The modules that import each declared binding, keyed by `bindingKey`. */
  readonly importers: ReadonlyMap<string, ReadonlySet<string>>;
}

const moduleFile = /\.(?:[cm]?[jt]sx?)$/u;

export const bindingKey = (binding: Binding): string => `${binding.path}#${binding.name}`;

/** The app, package, or tool directory that holds `path`, such as `packages/domain`. */
export const packageOf = (path: string): string | undefined => {
  const directory = path.split("/").slice(0, 2).join("/");

  return Object.hasOwn(packageDirectories, directory) ? directory : undefined;
};

const parseModule = (path: string, text: string): Module => {
  const parsed = parseSync(path, text);
  const imports: Array<Import> = [];
  const namespaces = new Map<string, string>();
  const importsByName = new Map<number, Import>();
  const importRequests = new Set<number>();

  for (const statement of parsed.module.staticImports) {
    const specifier = statement.moduleRequest.value;

    importRequests.add(statement.moduleRequest.start);

    for (const entry of statement.entries) {
      const { importName, localName } = entry;

      if (importName.kind === "NamespaceObject") {
        namespaces.set(localName.value, specifier);

        // A namespace import counts as an import of each member that the module reads from it.
        const members = new RegExp(
          `(?<![\\w$.])${localName.value.replaceAll("$", "\\$")}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`,
          "gu",
        );

        for (const member of new Set([...text.matchAll(members)].map(([, name = ""]) => name)))
          imports.push({ specifier, name: member });

        continue;
      }

      const imported = {
        specifier,
        name: importName.kind === "Default" ? "default" : (importName.name ?? "default"),
      };

      imports.push(imported);

      if (importName.start !== null) importsByName.set(importName.start, imported);
    }
  }

  const locals = new Map<string, string>();
  const forwards = new Map<string, Import>();
  const stars: Array<string> = [];

  for (const statement of parsed.module.staticExports)
    for (const entry of statement.entries) {
      const { exportName, importName, localName, moduleRequest } = entry;
      const exported = exportName.kind === "Default" ? "default" : exportName.name;

      if (moduleRequest === null) {
        const local = localName.name ?? "default";
        const namespace = namespaces.get(local);

        if (exported === null) continue;

        if (namespace === undefined) locals.set(exported, local);
        else forwards.set(exported, { specifier: namespace, name: "*" });

        continue;
      }

      // Oxc files `import { a } from "m"; export { a }` under the import statement, with the
      // span of the imported name; the import entry at that span holds the imported name.
      const indirect = importRequests.has(moduleRequest.start)
        ? importsByName.get(importName.start ?? -1)
        : undefined;

      if (exported === null) stars.push(moduleRequest.value);
      else
        forwards.set(
          exported,
          indirect ?? {
            specifier: moduleRequest.value,
            name: importName.kind === "Name" ? (importName.name ?? "default") : "*",
          },
        );
    }

  return {
    path,
    locals,
    forwards,
    stars,
    imports,
    errors: parsed.errors.map((error) => error.message),
  };
};

// ---------------------------------------------------------------------------------------------
// Resolution

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    exports: Schema.optional(Schema.Json),
    scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);

export type PackageManifest = typeof Manifest.Type;

/** The `package.json` of an app, package, or tool directory, if it has one. */
export const readManifest = (
  repository: Repository,
  directory: string,
): PackageManifest | undefined =>
  repository.paths.includes(`${directory}/package.json`)
    ? Schema.decodeSync(Manifest)(repository.read(`${directory}/package.json`))
    : undefined;

const TsConfig = Schema.fromJsonString(
  Schema.Struct({
    compilerOptions: Schema.optional(
      Schema.Struct({
        baseUrl: Schema.optional(Schema.String),
        paths: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
      }),
    ),
  }),
);

const decodeTsConfig = Schema.decodeSync(TsConfig);

// tsconfig.json is JSON with comments and trailing commas.
const jsonWithComments = /"(?:[^"\\\n]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(?=\s*[\]}])/gu;

// The conditions that the TypeScript configuration resolves; a target lists them in its order.
const conditions = {
  "@vektorprogrammet/source": true,
  types: true,
  import: true,
  default: true,
} satisfies Readonly<Record<string, true>>;

// A type guard, because `Array.isArray` does not narrow a readonly array out of a union.
const isJsonObject = (value: Schema.Json): value is Readonly<Record<string, Schema.Json>> =>
  value !== null &&
  !Predicate.isString(value) &&
  !Predicate.isBoolean(value) &&
  !Predicate.isNumber(value) &&
  !Array.isArray(value);

const exportTarget = (value: Schema.Json): string | undefined => {
  if (Predicate.isString(value)) return value;

  const alternatives: ReadonlyArray<Schema.Json> = isJsonObject(value)
    ? Object.entries(value).flatMap(([condition, item]) =>
        Object.hasOwn(conditions, condition) ? [item] : [],
      )
    : Array.isArray(value)
      ? value
      : [];

  for (const alternative of alternatives) {
    const target = exportTarget(alternative);

    if (target !== undefined) return target;
  }

  return undefined;
};

// A pattern holds at most one `*`, as in package `exports` and tsconfig `paths`.
const matchPattern = (pattern: string, value: string): string | undefined => {
  const star = pattern.indexOf("*");

  if (star === -1) return pattern === value ? "" : undefined;

  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);

  return value.length >= prefix.length + suffix.length &&
    value.startsWith(prefix) &&
    value.endsWith(suffix)
    ? value.slice(prefix.length, value.length - suffix.length)
    : undefined;
};

// `exports` is one target for `.`, or an object of subpaths.
const subpaths = (exports: Schema.Json): Readonly<Record<string, Schema.Json>> =>
  isJsonObject(exports) && Object.keys(exports).some((key) => key.startsWith("."))
    ? exports
    : { ".": exports };

/** One `exports` subpath, such as `./outbox-lifecycle`, and the file it names. */
export interface EntryPoint {
  readonly subpath: string;
  /** The target path relative to the package directory, without `./`. */
  readonly target: string;
}

/** The subpaths of a package's `exports` under the conditions that the repository resolves. */
export const entryPoints = (exports: Schema.Json): ReadonlyArray<EntryPoint> =>
  Object.entries(subpaths(exports)).flatMap(([subpath, value]) => {
    const target = exportTarget(value);

    return target === undefined ? [] : [{ subpath, target: posix.normalize(target) }];
  });

const subpathTarget = (exports: Schema.Json, subpath: string): string | undefined => {
  const map = subpaths(exports);
  const exact = map[subpath];

  if (exact !== undefined) return exportTarget(exact);

  // The longest pattern wins, as Node resolves `exports` patterns.
  const [best] = Object.entries(map)
    .flatMap(([pattern, target]) => {
      const matched = matchPattern(pattern, subpath);

      return matched === undefined || !pattern.includes("*") ? [] : [{ pattern, target, matched }];
    })
    .sort((left, right) => right.pattern.length - left.pattern.length);

  if (best === undefined) return undefined;

  return exportTarget(best.target)?.replaceAll("*", best.matched);
};

const moduleExtensions = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];

// TypeScript resolves `./file.js` to `./file.ts`, and an extensionless path to a file or index.
const candidates = (path: string): ReadonlyArray<string> => {
  const extension = /\.[cm]?[jt]sx?$/u.exec(path)?.[0];

  if (extension === undefined)
    return [
      ...moduleExtensions.map((suffix) => `${path}${suffix}`),
      ...moduleExtensions.map((suffix) => `${path}/index${suffix}`),
    ];

  const stem = path.slice(0, -extension.length);

  switch (extension) {
    case ".js":
      return [`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, path];
    case ".jsx":
      return [`${stem}.tsx`, path];
    case ".mjs":
      return [`${stem}.mts`, `${stem}.d.mts`, path];
    case ".cjs":
      return [`${stem}.cts`, `${stem}.d.cts`, path];
    default:
      return [path, ...moduleExtensions.map((suffix) => `${path}${suffix}`)];
  }
};

interface WorkspacePackage {
  readonly directory: string;
  readonly exports: Schema.Json | undefined;
}

interface PathAlias {
  readonly pattern: string;
  readonly targets: ReadonlyArray<string>;
}

const readResolver = (
  repository: Repository,
  files: ReadonlySet<string>,
): ModuleGraph["resolve"] => {
  const workspaces = new Map<string, WorkspacePackage>();
  const aliases = new Map<string, ReadonlyArray<PathAlias>>();

  for (const directory of Object.keys(packageDirectories)) {
    const manifest = readManifest(repository, directory);

    if (manifest?.name !== undefined)
      workspaces.set(manifest.name, { directory, exports: manifest.exports });

    if (files.has(`${directory}/tsconfig.json`)) {
      const options = decodeTsConfig(
        repository
          .read(`${directory}/tsconfig.json`)
          .replaceAll(jsonWithComments, (match) => (match.startsWith('"') ? match : "")),
      ).compilerOptions;

      const base = posix.join(directory, options?.baseUrl ?? ".");

      aliases.set(
        directory,
        Object.entries(options?.paths ?? {}).map(([pattern, targets]) => ({
          pattern,
          targets: targets.map((target) => posix.join(base, target)),
        })),
      );
    }
  }

  const file = (path: string): string | undefined =>
    candidates(path).find((candidate) => files.has(candidate));

  const packageTarget = (specifier: string): string | undefined => {
    const segments = specifier.split("/");
    const length = specifier.startsWith("@") ? 2 : 1;
    const workspace = workspaces.get(segments.slice(0, length).join("/"));

    if (workspace === undefined) return undefined;

    const rest = segments.slice(length).join("/");

    if (workspace.exports === undefined)
      return file(posix.join(workspace.directory, rest === "" ? "index" : rest));

    const target = subpathTarget(workspace.exports, rest === "" ? "." : `./${rest}`);

    return target === undefined ? undefined : file(posix.join(workspace.directory, target));
  };

  const aliasTarget = (importer: string, specifier: string): string | undefined => {
    const directory = packageOf(importer);

    for (const alias of (directory === undefined ? undefined : aliases.get(directory)) ?? []) {
      const matched = matchPattern(alias.pattern, specifier);

      if (matched === undefined) continue;

      for (const target of alias.targets) {
        const resolved = file(target.replaceAll("*", matched));

        if (resolved !== undefined) return resolved;
      }
    }

    return undefined;
  };

  const cache = new Map<string, string | undefined>();

  return (importer, specifier) => {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    const key = relative ? posix.join(posix.dirname(importer), specifier) : specifier;

    if (cache.has(key) && relative) return cache.get(key);

    const resolved = relative
      ? file(key)
      : (aliasTarget(importer, specifier) ?? packageTarget(specifier));

    if (relative) cache.set(key, resolved);

    return resolved;
  };
};

// ---------------------------------------------------------------------------------------------
// The graph

/** Parses every module of the repository and resolves its imports. */
export const readModuleGraph = (repository: Repository): ModuleGraph => {
  const files = new Set(repository.paths);
  const modules = new Map<string, Module>();

  for (const path of repository.paths)
    if (moduleFile.test(path) && !repository.links.has(path))
      modules.set(path, parseModule(path, repository.read(path)));

  const resolve = readResolver(repository, files);
  const origins = new Map<string, Binding | undefined>();

  const origin = (binding: Binding, visiting = new Set<string>()): Binding | undefined => {
    const key = bindingKey(binding);

    if (origins.has(key)) return origins.get(key);

    if (visiting.has(key)) return undefined;

    visiting.add(key);

    const module = modules.get(binding.path);
    let found: Binding | undefined;

    if (module === undefined || binding.name === "*") found = undefined;
    else if (module.locals.has(binding.name)) found = binding;
    else {
      const forward = module.forwards.get(binding.name);

      if (forward !== undefined) {
        const target = resolve(module.path, forward.specifier);

        found =
          target === undefined ? undefined : origin({ path: target, name: forward.name }, visiting);
      } else if (binding.name !== "default")
        for (const star of module.stars) {
          const target = resolve(module.path, star);

          found =
            target === undefined
              ? undefined
              : origin({ path: target, name: binding.name }, visiting);

          if (found !== undefined) break;
        }
    }

    origins.set(key, found);

    return found;
  };

  const importers = new Map<string, Set<string>>();

  for (const module of modules.values())
    for (const imported of module.imports) {
      const target = resolve(module.path, imported.specifier);

      const declared =
        target === undefined ? undefined : origin({ path: target, name: imported.name });

      if (declared === undefined || declared.path === module.path) continue;

      const key = bindingKey(declared);
      const set = importers.get(key) ?? new Set<string>();

      set.add(module.path);
      importers.set(key, set);
    }

  return { modules, resolve, origin: (binding) => origin(binding), importers };
};
