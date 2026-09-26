/**
 * The hosted journeys. The journey recipes of the justfile each accept a closed set of names: the
 * patterns of the one `case` statement that rejects every other name with `*)`. The Tests workflow
 * runs each name as one leg of its matrix job, unless this declaration gives the journey a job of
 * its own or excludes it with its reason. `just layout write` renders the legs and the hosted
 * journeys section of docs/web-system-functional-testing.md from the sets and this declaration;
 * `just layout` reports every fact that disagrees with them. Change the hosting here first.
 *
 * A name also runs files: those that its command names, and in turn those that journey code
 * names, such as the Playwright spec that a browser runner starts. Every Playwright spec of the
 * apps and every file of the acceptance probes runs under some name, or this declaration excludes
 * it with its reason, so no check exists that nothing runs.
 */
import { posix } from "node:path";
import { Schema } from "effect";
import type { Finding } from "./check.js";
import type { CaseStatement, Justfile, Recipe } from "./justfile.js";
import { packageDirectories } from "./layout.js";
import { moduleCandidates, readManifest } from "./modules.js";
import type { Repository } from "./repository.js";

export const journeysDeclaration = "tools/conventions/src/journeys.ts";

/** The recipes whose `case` statement is a closed set of journeys, in leg order. */
export const journeyRecipes = ["golden", "e2e", "proof", "rehearsal"] as const;

export type JourneyRecipe = (typeof journeyRecipes)[number];

/** The workflow that hosts the journeys. */
export const testsWorkflow = ".github/workflows/tests.yml";

/** The job of the workflow that runs one journey on each leg of its matrix. */
export const matrixJob = "browser-journeys";

/** The journey recipe that runs the browser evidence scripts of the apps. */
export const evidenceRecipe: JourneyRecipe = "e2e";

/** The browser evidence scripts of an app. `just e2e` runs each one, or `exclusions` lists it. */
export const evidenceScripts = ["e2e:real-*", "e2e:*:real", "e2e:*:native"] as const;

/** The files that a journey must run, unless `exclusions` lists them, and what each one is. */
export const runFiles = [
  { kind: "Playwright spec", glob: "apps/*/e2e/**/*.spec.{ts,mjs}" },
  { kind: "file of an acceptance probe", glob: "tools/acceptance/**/*.{ts,mjs}" },
] as const;

/** Tests of the run files, which their package's test script runs instead of a journey. */
const runFileTests = "**/*.test.{ts,mjs}";

/** A name of a journey set, such as `identity` of `just e2e`. */
export interface Journey {
  readonly recipe: JourneyRecipe;
  readonly name: string;
}

/** A journey that a job of its own runs instead of a matrix leg. */
export interface OwnJob extends Journey {
  /** The id of the job in the workflow. */
  readonly job: string;
  readonly reason: string;
}

export const ownJobs: ReadonlyArray<OwnJob> = [
  {
    recipe: "golden",
    name: "school-service",
    job: "golden-school-service",
    reason:
      "The required functional gate. Its CI wrapper accepts the exact-source evidence and uploads the sanitized evidence.",
  },
  {
    recipe: "e2e",
    name: "identity",
    job: "identity-browser-evidence",
    reason: "The job uploads the receipt that the journey prints as sanitized evidence.",
  },
  {
    recipe: "e2e",
    name: "applicant",
    job: "applicant-evidence",
    reason:
      "The job uploads the evidence that the journey writes, and it gives the journey a longer timeout than a leg.",
  },
];

/**
 * A journey, a browser evidence script of an app, or a file that the workflow does not run. An
 * excluded script or file also excludes the files that it runs.
 */
export type Exclusion =
  | (Journey & { readonly reason: string })
  | { readonly directory: string; readonly script: string; readonly reason: string }
  | { readonly file: string; readonly reason: string };

const legacyDataMariaDb =
  "Needs MariaDB from the legacy-data devenv profile; the hosted legs run the default profile";

const devenvUpStack =
  "Needs a running stack with the accounts of just seed, such as devenv up, and REAL_NATIVE_IDENTITY_E2E and DASHBOARD_ORIGIN set; no runner owns that topology, and without it every test skips";

const teamInterestStack =
  "Needs a stack that e2e/native-team-interest-mailing-list-seed.mjs seeds, with REAL_NATIVE_IDENTITY_E2E set; no runner or recipe provides it, and without it every test skips";

export const exclusions: ReadonlyArray<Exclusion> = [
  {
    recipe: "proof",
    name: "authorization-rules",
    reason:
      "Fails on main after its migration preflight: the admission matrix step compares an AdmissionPeriod instance with a plain object (packages/database/runtime/authorization-rules-postgres-proof-main.ts)",
  },
  {
    recipe: "rehearsal",
    name: "account-cohort",
    reason:
      "Needs the PHP CLI of the legacy-data devenv profile; the hosted legs run the default profile",
  },
  { recipe: "rehearsal", name: "legacy-current-assignment", reason: legacyDataMariaDb },
  { recipe: "rehearsal", name: "legacy-organization", reason: legacyDataMariaDb },
  { recipe: "rehearsal", name: "legacy-receipt", reason: legacyDataMariaDb },
  { recipe: "rehearsal", name: "legacy-candidate", reason: legacyDataMariaDb },
  {
    directory: "apps/dashboard",
    script: "e2e:real-oauth",
    reason: "Needs an external topology; without one, Playwright skips every test",
  },
  { file: "apps/dashboard/e2e/native-session-journey.spec.ts", reason: devenvUpStack },
  { file: "apps/dashboard/e2e/native-users-journey.spec.ts", reason: devenvUpStack },
  { file: "apps/dashboard/e2e/native-team-interest-journey.spec.ts", reason: teamInterestStack },
  { file: "apps/dashboard/e2e/native-mailing-lists-journey.spec.ts", reason: teamInterestStack },
  {
    file: "apps/dashboard/e2e/native-recruitment-assignment.spec.ts",
    reason:
      "Superseded by native-recruitment-session-journey.spec.ts, which just e2e recruitment runs; nothing sets its REAL_RECRUITMENT_E2E variables, so every test skips",
  },
  {
    file: "apps/homepage/e2e/preview-smoke.spec.ts",
    reason: "Needs a deployed preview origin in PREVIEW_BASE_URL; without one, every test skips",
  },
];

const sameJourney = (left: Journey, right: Journey): boolean =>
  left.recipe === right.recipe && left.name === right.name;

export const ownJobOf = (journey: Journey): OwnJob | undefined =>
  ownJobs.find((entry) => sameJourney(entry, journey));

export const exclusionOf = (journey: Journey): Exclusion | undefined =>
  exclusions.find((entry) => "recipe" in entry && sameJourney(entry, journey));

interface JourneySet {
  readonly recipe: JourneyRecipe;
  readonly found: Recipe | undefined;
  /** The `case` statement that holds the set, if the recipe has exactly one with a `*)` branch. */
  readonly dispatch: CaseStatement | undefined;
}

const readJourneySets = (justfile: Justfile): ReadonlyArray<JourneySet> =>
  journeyRecipes.map((recipe) => {
    const found = justfile.recipes.find((candidate) => candidate.name === recipe);
    const dispatches = found?.cases.filter((statement) => statement.otherwise !== undefined) ?? [];

    return { recipe, found, dispatch: dispatches.length === 1 ? dispatches[0] : undefined };
  });

/** Every name of the journey sets in leg order: by recipe, then in the order of the patterns. */
export const journeys = (justfile: Justfile): ReadonlyArray<Journey> =>
  readJourneySets(justfile).flatMap(({ recipe, dispatch }) =>
    [...new Set(dispatch?.branches.flatMap((branch) => branch.patterns))].map((name) => ({
      recipe,
      name,
    })),
  );

/** The legs of the matrix job: every journey without a job of its own or an exclusion. */
export const legs = (justfile: Justfile): ReadonlyArray<Journey> =>
  journeys(justfile).filter(
    (journey) => ownJobOf(journey) === undefined && exclusionOf(journey) === undefined,
  );

const WorkflowFile = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      name: Schema.optional(Schema.String),
      strategy: Schema.optional(Schema.Unknown),
    }),
  ),
});

const MatrixStrategy = Schema.Struct({
  matrix: Schema.Struct({
    include: Schema.Array(Schema.Struct({ recipe: Schema.String, suite: Schema.String })),
  }),
});

export interface Workflow {
  /** The name that GitHub shows for each job id. */
  readonly jobs: ReadonlyMap<string, string>;
  /** The legs of the matrix job, if its matrix is an include list of recipe and suite legs. */
  readonly legs: ReadonlyArray<{ readonly recipe: string; readonly suite: string }> | undefined;
}

/** The jobs and the matrix legs of the Tests workflow text. */
export const readWorkflow = (text: string): Workflow => {
  const { jobs } = Schema.decodeUnknownSync(WorkflowFile)(Bun.YAML.parse(text));
  const strategy = jobs[matrixJob]?.strategy;

  return {
    jobs: new Map(Object.entries(jobs).map(([id, job]) => [id, job.name ?? id])),
    legs: Schema.is(MatrixStrategy)(strategy) ? strategy.matrix.include : undefined,
  };
};

const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// `bun run --cwd <directory> <script>`, where either word can be quoted.
const packageScript = /\bbun\s+run\s+--cwd\s+([^\s;&|]+)\s+([^\s;&|]+)/gu;

const unquote = (word: string): string => word.replaceAll(/["']/gu, "");

// A quoted string that can name a file: a relative specifier, or a path with a script extension.
const quotedPath = /(["'`])((?:\.\.?\/)?[\w@-][\w@./-]*)\1/gu;

const scriptExtension = /\.[cm]?[jt]sx?$/u;

const relativePath = /^\.\.?\//u;

// The files whose names of other files a run follows: the browser runners, drivers, and probes.
const journeyCode = /^(?:apps\/[^/]+\/e2e|tools)\//u;

const appDirectories = Object.keys(packageDirectories).filter((directory) =>
  directory.startsWith("apps/"),
);

/** What a command runs: its package scripts, as `<directory> <script>`, and its files. */
interface Run {
  readonly scripts: ReadonlySet<string>;
  readonly files: ReadonlySet<string>;
}

/**
 * The runs of commands in `repository`. A command runs the files that its words name, and the
 * package scripts that it starts with `bun run --cwd`; a file runs the files that its quoted strings
 * name. A relative path resolves from the directory of the command or file. A path with a script
 * extension also resolves from the root and from each app directory, where the browser runners
 * start Playwright. A run follows the files that its command names and the journey code that they
 * name, but not the application code that they import.
 */
const readRuns = (repository: Repository): ((command: string, directory?: string) => Run) => {
  const files = new Set(repository.paths);
  const names = new Map<string, ReadonlyArray<string>>();

  const resolve = (directory: string, paths: ReadonlyArray<string>): ReadonlyArray<string> =>
    paths.flatMap((path) => {
      const bases = relativePath.test(path)
        ? [directory]
        : scriptExtension.test(path)
          ? [directory, "", ...appDirectories]
          : [];

      return bases.flatMap((base) => {
        const found = moduleCandidates(posix.join(base, path)).find((file) => files.has(file));

        return found === undefined ? [] : [found];
      });
    });

  const named = (file: string): ReadonlyArray<string> => {
    const cached = names.get(file);

    if (cached !== undefined) return cached;

    const found = resolve(
      posix.dirname(file),
      [...repository.read(file).matchAll(quotedPath)].map(([, , text = ""]) => text),
    );

    names.set(file, found);

    return found;
  };

  return (command, directory = "") => {
    const scripts = new Set<string>();
    const seeds = new Set<string>();

    const visit = (text: string, from: string): void => {
      for (const file of resolve(from, text.split(/[\s;&|()]+/u).map(unquote))) seeds.add(file);

      for (const [, where = "", script = ""] of text.matchAll(packageScript)) {
        const at = posix.join(from, unquote(where)).replace(/\/$/u, "");
        const name = unquote(script);

        if (scripts.has(`${at} ${name}`)) continue;

        scripts.add(`${at} ${name}`);

        const body = readManifest(repository, at)?.scripts?.[name];

        if (body !== undefined) visit(body, at);
      }
    };

    visit(command, directory);

    const run = new Set<string>();
    const queue = [...seeds];

    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
      if (run.has(file)) continue;

      run.add(file);

      if (seeds.has(file) || journeyCode.test(file)) queue.push(...named(file));
    }

    return { scripts, files: run };
  };
};

/** The command of the branch that accepts `name`, with the case subject replaced by the name. */
const commandOf = (dispatch: CaseStatement, name: string): string => {
  const variable = dispatch.subject.replace(/^\$\{?(.*?)\}?$/u, "$1");
  const branch = dispatch.branches.find(({ patterns }) => patterns.includes(name));

  return (branch?.command ?? "")
    .replaceAll(`\${${variable}}`, name)
    .replaceAll(`$${variable}`, name);
};

/** Every hosting finding: the journey sets, this declaration, the workflow, and the app scripts. */
export const checkJourneys = (
  repository: Repository,
  justfile: Justfile,
  workflow: Workflow,
): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = [];
  const sets = readJourneySets(justfile);
  const members = journeys(justfile);

  for (const { recipe, found, dispatch } of sets) {
    if (found === undefined) {
      findings.push({
        path: journeysDeclaration,
        message: `names the journey recipe ${recipe}, which the justfile lacks; remove it from journeyRecipes`,
      });

      continue;
    }

    if (dispatch === undefined) {
      findings.push({
        path: "justfile",
        message: `the ${recipe} recipe needs exactly one case statement with a *) branch; the journey check reads the names of the recipe from its patterns`,
      });

      continue;
    }

    const names = [...new Set(dispatch.branches.flatMap((branch) => branch.patterns))];

    for (const name of names)
      if (!kebabCase.test(name))
        findings.push({
          path: "justfile",
          message: `the ${recipe} recipe accepts ${name}, which is not a kebab-case name; a journey set lists names, not patterns`,
        });

    // Both list the names in English, such as `a, b, or c`.
    for (const [place, list = ""] of [
      ["doc comment", /:\s+([^:]*?)\.?$/u.exec(found.doc)?.[1]],
      ["unknown-name message", /\bUse\s+([^."]*)\./u.exec(dispatch.otherwise ?? "")?.[1]],
    ] as const) {
      const listed = list
        .split(/,\s*(?:or\s+)?|\s+or\s+/u)
        .map((name) => name.trim())
        .filter((name) => name !== "");

      const lacking = names.filter((name) => !listed.includes(name));
      const extra = listed.filter((name) => !names.includes(name));

      if (lacking.length > 0 || extra.length > 0)
        findings.push({
          path: "justfile",
          message: `the ${place} of the ${recipe} recipe lists other names than its case statement${lacking.length > 0 ? `; add ${lacking.join(", ")}` : ""}${extra.length > 0 ? `; remove ${extra.join(", ")}` : ""}`,
        });
    }
  }

  for (const entry of ownJobs) {
    const command = `just ${entry.recipe} ${entry.name}`;

    if (!members.some((member) => sameJourney(member, entry)))
      findings.push({
        path: journeysDeclaration,
        message: `gives ${command} the job ${entry.job}, but the ${entry.recipe} recipe does not accept ${entry.name}; remove the entry`,
      });

    if (!workflow.jobs.has(entry.job))
      findings.push({
        path: journeysDeclaration,
        message: `gives ${command} the job ${entry.job}, which ${testsWorkflow} lacks`,
      });

    if (exclusionOf(entry) !== undefined)
      findings.push({
        path: journeysDeclaration,
        message: `gives ${command} a job of its own and also excludes it; remove one entry`,
      });
  }

  if (!workflow.jobs.has(matrixJob))
    findings.push({
      path: journeysDeclaration,
      message: `names the matrix job ${matrixJob}, which ${testsWorkflow} lacks`,
    });
  else if (workflow.legs === undefined)
    findings.push({
      path: testsWorkflow,
      message: `the ${matrixJob} job has no matrix include list of recipe and suite legs`,
    });
  else
    for (const journey of legs(justfile))
      if (!workflow.legs.some((leg) => leg.recipe === journey.recipe && leg.suite === journey.name))
        findings.push({
          path: testsWorkflow,
          message: `does not run just ${journey.recipe} ${journey.name}: it is not a ${matrixJob} leg, and ${journeysDeclaration} neither gives it a job of its own nor excludes it. Run just layout write, or declare it there`,
        });

  const runOf = readRuns(repository);
  const evidence = new Set<string>();
  // The first journey, in leg order, that runs each file.
  const runners = new Map<string, Journey>();

  for (const journey of members) {
    const dispatch = sets.find((set) => set.recipe === journey.recipe)?.dispatch;

    if (dispatch === undefined) continue;

    const run = runOf(commandOf(dispatch, journey.name));

    if (journey.recipe === evidenceRecipe) for (const script of run.scripts) evidence.add(script);

    for (const file of run.files) if (!runners.has(file)) runners.set(file, journey);
  }

  // The files that an excluded script or file would run.
  const excluded = new Set<string>();

  for (const entry of exclusions)
    if ("recipe" in entry) {
      if (!members.some((member) => sameJourney(member, entry)))
        findings.push({
          path: journeysDeclaration,
          message: `excludes just ${entry.recipe} ${entry.name}, but the ${entry.recipe} recipe does not accept ${entry.name}; remove the entry`,
        });
    } else if ("script" in entry) {
      const script = `the script ${entry.script} of ${entry.directory}`;

      if (!Object.hasOwn(readManifest(repository, entry.directory)?.scripts ?? {}, entry.script))
        findings.push({
          path: journeysDeclaration,
          message: `excludes ${script}, which does not exist; remove the entry`,
        });
      else if (evidence.has(`${entry.directory} ${entry.script}`))
        findings.push({
          path: journeysDeclaration,
          message: `excludes ${script}, which just ${evidenceRecipe} runs; remove the entry`,
        });

      for (const file of runOf(`bun run --cwd ${entry.directory} ${entry.script}`).files)
        excluded.add(file);
    } else {
      const journey = runners.get(entry.file);

      if (!repository.paths.includes(entry.file))
        findings.push({
          path: journeysDeclaration,
          message: `excludes ${entry.file}, which does not exist; remove the entry`,
        });
      else if (journey !== undefined)
        findings.push({
          path: journeysDeclaration,
          message: `excludes ${entry.file}, which just ${journey.recipe} ${journey.name} runs; remove the entry`,
        });

      for (const file of runOf(entry.file).files) excluded.add(file);
    }

  const globs = evidenceScripts.map((pattern) => new Bun.Glob(pattern));

  for (const path of repository.paths) {
    const directory = /^(apps\/[^/]+)\/package\.json$/u.exec(path)?.[1];

    if (directory === undefined) continue;

    for (const script of Object.keys(readManifest(repository, directory)?.scripts ?? {}))
      if (
        globs.some((glob) => glob.match(script)) &&
        !evidence.has(`${directory} ${script}`) &&
        !exclusions.some(
          (entry) => "script" in entry && entry.directory === directory && entry.script === script,
        )
      )
        findings.push({
          path,
          message: `has the browser evidence script ${script}, which just ${evidenceRecipe} does not run. Add its suite to the ${evidenceRecipe} recipe, or exclude it with its reason in ${journeysDeclaration}`,
        });
  }

  const kinds = runFiles.map(({ kind, glob }) => ({ kind, glob: new Bun.Glob(glob) }));
  const tests = new Bun.Glob(runFileTests);
  const recipes = journeyRecipes.map((recipe) => `just ${recipe}`);

  for (const path of repository.paths) {
    const kind = kinds.find(({ glob }) => glob.match(path))?.kind;

    if (kind === undefined || tests.match(path) || runners.has(path) || excluded.has(path))
      continue;

    findings.push({
      path,
      message: `is a ${kind} that no journey runs: no name of ${recipes.slice(0, -1).join(", ")}, or ${recipes.at(-1) ?? ""} runs it, directly or through a file that it runs. Run it from a journey, or exclude it with its reason in ${journeysDeclaration}`,
    });
  }

  return findings;
};
