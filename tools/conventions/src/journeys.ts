/**
 * The hosted journeys. The journey recipes of the justfile each accept a closed set of names: the
 * patterns of the one `case` statement that rejects every other name with `*)`. The Tests workflow
 * runs each name as one leg of its matrix job, unless this declaration gives the journey a job of
 * its own or excludes it with its reason. `just layout write` renders the legs and the hosted
 * journeys section of docs/web-system-functional-testing.md from the sets and this declaration;
 * `just layout` reports every fact that disagrees with them. Change the hosting here first.
 */
import { posix } from "node:path";
import { Schema } from "effect";
import type { Finding } from "./check.js";
import type { CaseStatement, Justfile, Recipe } from "./justfile.js";
import { readManifest } from "./modules.js";
import type { Repository } from "./repository.js";

export const journeysDeclaration = "tools/conventions/src/journeys.ts";

/** The recipes whose `case` statement is a closed set of journeys, in leg order. */
export const journeyRecipes = ["golden", "e2e", "proof"] as const;

export type JourneyRecipe = (typeof journeyRecipes)[number];

/** The workflow that hosts the journeys. */
export const testsWorkflow = ".github/workflows/tests.yml";

/** The job of the workflow that runs one journey on each leg of its matrix. */
export const matrixJob = "browser-journeys";

/** The journey recipe that runs the browser evidence scripts of the apps. */
export const evidenceRecipe: JourneyRecipe = "e2e";

/** The browser evidence scripts of an app. `just e2e` runs each one, or `exclusions` lists it. */
export const evidenceScripts = ["e2e:real-*", "e2e:*:real", "e2e:*:native"] as const;

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

/** A journey, or a browser evidence script of an app, that the workflow does not run. */
export type Exclusion =
  | (Journey & { readonly reason: string })
  | { readonly directory: string; readonly script: string; readonly reason: string };

export const exclusions: ReadonlyArray<Exclusion> = [
  {
    recipe: "proof",
    name: "authorization-rules",
    reason:
      "Fails on main after its migration preflight: the admission matrix step compares an AdmissionPeriod instance with a plain object (packages/database/runtime/authorization-rules-postgres-proof-main.ts)",
  },
  {
    directory: "apps/dashboard",
    script: "e2e:real-oauth",
    reason: "Needs an external topology; without one, Playwright skips every test",
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

/**
 * The package scripts that a `case` statement runs, as `<directory> <script>`. A branch runs its
 * script once for each of its names, which the case subject holds.
 */
const scriptsRun = (dispatch: CaseStatement): ReadonlyArray<string> => {
  const variable = dispatch.subject.replace(/^\$\{?(.*?)\}?$/u, "$1");

  return dispatch.branches.flatMap(({ patterns, command }) =>
    [...command.matchAll(packageScript)].flatMap(([, directory = "", script = ""]) =>
      patterns.map((name) => {
        const expanded = script
          .replaceAll(/["']/gu, "")
          .replaceAll(`\${${variable}}`, name)
          .replaceAll(`$${variable}`, name);

        return `${posix.normalize(directory.replaceAll(/["']/gu, "")).replace(/\/$/u, "")} ${expanded}`;
      }),
    ),
  );
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

  const evidence = sets.find((set) => set.recipe === evidenceRecipe)?.dispatch;
  const reachable = new Set(evidence === undefined ? [] : scriptsRun(evidence));

  for (const entry of exclusions)
    if ("script" in entry) {
      const excluded = `the script ${entry.script} of ${entry.directory}`;

      if (!Object.hasOwn(readManifest(repository, entry.directory)?.scripts ?? {}, entry.script))
        findings.push({
          path: journeysDeclaration,
          message: `excludes ${excluded}, which does not exist; remove the entry`,
        });
      else if (reachable.has(`${entry.directory} ${entry.script}`))
        findings.push({
          path: journeysDeclaration,
          message: `excludes ${excluded}, which just ${evidenceRecipe} runs; remove the entry`,
        });
    } else if (!members.some((member) => sameJourney(member, entry)))
      findings.push({
        path: journeysDeclaration,
        message: `excludes just ${entry.recipe} ${entry.name}, but the ${entry.recipe} recipe does not accept ${entry.name}; remove the entry`,
      });

  const globs = evidenceScripts.map((pattern) => new Bun.Glob(pattern));

  for (const path of repository.paths) {
    const directory = /^(apps\/[^/]+)\/package\.json$/u.exec(path)?.[1];

    if (directory === undefined) continue;

    for (const script of Object.keys(readManifest(repository, directory)?.scripts ?? {}))
      if (
        globs.some((glob) => glob.match(script)) &&
        !reachable.has(`${directory} ${script}`) &&
        !exclusions.some(
          (entry) => "script" in entry && entry.directory === directory && entry.script === script,
        )
      )
        findings.push({
          path,
          message: `has the browser evidence script ${script}, which just ${evidenceRecipe} does not run. Add its suite to the ${evidenceRecipe} recipe, or exclude it with its reason in ${journeysDeclaration}`,
        });
  }

  return findings;
};
