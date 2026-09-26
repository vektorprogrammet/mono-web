// Negative controls run against the real repository and justfile with one change each: one more
// e2e suite in the justfile dump, one more browser evidence script, or a renamed workflow job.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkLayout } from "../src/check.js";
import { journeysDeclaration, readWorkflow, testsWorkflow } from "../src/journeys.js";
import { decodeJustfile, dumpJustfile, type Justfile } from "../src/justfile.js";
import { readRepository, repositoryRoot, type Repository } from "../src/repository.js";
import { spliceFiles } from "../src/sections.js";

const root = repositoryRoot(import.meta.dir);

const base = readRepository(root, false);

const dump = dumpJustfile(join(root, "justfile"));

const justfile = decodeJustfile(dump);

const withFiles = (files: Readonly<Record<string, string>>): Repository => ({
  root,
  paths: [...new Set([...base.paths, ...Object.keys(files)])].sort(),
  links: base.links,
  read: (path) => files[path] ?? base.read(path),
  readLink: base.readLink,
});

/** The repository after `just layout write` with `subject`. */
const written = (subject: Justfile): Repository =>
  withFiles(
    Object.fromEntries(
      spliceFiles(base.read, subject, readWorkflow(base.read(testsWorkflow))).map(
        ({ path, text }) => [path, text],
      ),
    ),
  );

/**
 * The justfile with `suite` as one more pattern of the first branch of the e2e `case` statement.
 * With `listed`, the doc comment and the unknown-name message of the recipe also name it.
 */
const withSuite = (suite: string, listed: boolean): Justfile => {
  // SAFETY: decodeJustfile(dump) above decoded this dump, so its e2e recipe has a doc string and a
  // body of fragment lines; decodeJustfile decodes the edited dump again.
  const parsed = JSON.parse(dump) as {
    recipes: { e2e: { doc: string; body: Array<Array<unknown>> } };
  };

  const { e2e } = parsed.recipes;
  const text = e2e.body.map((line) => line.join(""));
  const branch = text.findIndex((line) => /^\s*case\b/u.test(line)) + 1;

  text[branch] = (text[branch] ?? "").replace(/^(\s*)/u, `$1${suite} | `);

  if (listed) e2e.doc = e2e.doc.replace(": ", `: ${suite}, `);

  e2e.body = text.map((line) => [listed ? line.replace("Use ", `Use ${suite}, `) : line]);

  return decodeJustfile(JSON.stringify(parsed));
};

const messagesFor = (
  repository: Repository,
  subject: Justfile,
  path: string,
): ReadonlyArray<string> =>
  checkLayout(repository, subject).flatMap((finding) =>
    finding.path === path ? [finding.message] : [],
  );

describe("hosted journeys", () => {
  test("renders a new e2e suite as a leg, and reports the workflow until it runs the suite", () => {
    const fake = withSuite("fake-suite", true);
    const before = messagesFor(written(justfile), fake, testsWorkflow);

    expect(before).toHaveLength(2);
    expect(before.filter((message) => message.includes("just e2e fake-suite"))).toHaveLength(1);

    const after = written(fake);

    expect(readWorkflow(after.read(testsWorkflow)).legs).toContainEqual({
      recipe: "e2e",
      suite: "fake-suite",
    });

    expect(messagesFor(after, fake, testsWorkflow)).toEqual([]);
  });

  test("rejects a doc comment and an unknown-name message that omit a suite", () => {
    const naming = (listed: boolean) =>
      messagesFor(base, withSuite("fake-suite", listed), "justfile").filter((message) =>
        message.includes("fake-suite"),
      );

    expect(naming(false)).toHaveLength(2);
    expect(naming(true)).toEqual([]);
  });

  test("rejects a browser evidence script that just e2e does not run, and accepts an excluded one", () => {
    const manifest = "apps/dashboard/package.json";

    const scripts = base
      .read(manifest)
      .replace('"scripts": {', '"scripts": {\n    "e2e:real-fake": "bun e2e/run-real-fake.mjs",');

    expect(messagesFor(withFiles({ [manifest]: scripts }), justfile, manifest)).toHaveLength(1);
    expect(messagesFor(base, justfile, manifest)).toEqual([]);
  });

  test("rejects a hosted job that the workflow lacks", () => {
    const workflow = base.read(testsWorkflow);
    const renamed = workflow.replace(/^ {2}applicant-evidence:$/mu, "  public-applicant:");

    expect(renamed).not.toBe(workflow);

    expect(
      messagesFor(withFiles({ [testsWorkflow]: renamed }), justfile, journeysDeclaration).filter(
        (message) => message.includes("applicant-evidence"),
      ),
    ).toHaveLength(1);
  });
});
