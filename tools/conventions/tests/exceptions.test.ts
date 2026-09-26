// Negative controls run against the real repository with a few in-memory files, so they exercise
// the real registry, package.json, and module guides.
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { Finding } from "../src/check.js";
import {
  checkExceptions,
  type EffectException,
  EffectExceptionRegistry,
  registry,
} from "../src/exceptions.js";
import { readRepository, repositoryRoot, type Repository } from "../src/repository.js";

const root = repositoryRoot(import.meta.dir);

const base = readRepository(root, false);

const withFiles = (files: Readonly<Record<string, string>>): Repository => ({
  root,
  paths: [...new Set([...base.paths, ...Object.keys(files)])].sort(),
  links: base.links,
  read: (path) => files[path] ?? base.read(path),
  readLink: base.readLink,
});

const registered = Schema.decodeSync(EffectExceptionRegistry)(base.read(registry));

const effectVersion = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      catalogs: Schema.Struct({ "effect-v4": Schema.Struct({ effect: Schema.String }) }),
    }),
  ),
)(base.read("package.json")).catalogs["effect-v4"].effect;

const probe = "packages/domain/src/shared-kernel/exception-probe.ts";

const id = "EX-9001";

const probeEntry: EffectException = {
  id,
  rules: ["FX002", "effect/no-cross-runtime"],
  scope: { files: [probe], symbols: ["probeUrl"] },
  reason: "The probe reads the location of the page.",
  missingCapability: "The probe lacks nothing.",
  nativeAlternatives: ["None."],
  verification: ["This test."],
  owner: "packages/domain/src/shared-kernel",
  examinedWith: { effect: effectVersion },
  retirementTrigger: "The test ends.",
};

const withEntry = (entry: EffectException) =>
  Schema.encodeSync(EffectExceptionRegistry)({
    ...registered,
    exceptions: [...registered.exceptions, entry],
  });

const registeredSuppression = [
  `// oxlint-disable-next-line effect/no-cross-runtime -- ${id}: the probe reads the page`,
  "export const probeUrl = new URL(window.location.href);",
  "",
].join("\n");

// The findings at the probe files, and the registry's findings about the probe entry.
const probeFindings = (
  files: Readonly<Record<string, string>>,
  paths: ReadonlyArray<string> = [probe],
): ReadonlyArray<Finding> =>
  checkExceptions(withFiles(files)).findings.filter(
    (finding) =>
      paths.some((path) => finding.path.startsWith(`${path}:`)) ||
      (finding.path === registry && finding.message.startsWith(`${id} `)),
  );

describe("Effect exception registry", () => {
  test("rejects a suppression of an Effect rule without an exception, and ignores other rules", () => {
    const findings = probeFindings({
      [probe]: [
        "// oxlint-disable-next-line effect/no-cross-runtime -- the probe reads the page",
        "export const probeUrl = new URL(window.location.href);",
        "// oxlint-disable-next-line no-console -- a rule outside the Effect plugins",
        "console.info(probeUrl);",
        "// oxlint-disable-next-line -- every rule",
        "console.info(window.location.href);",
        "",
      ].join("\n"),
    });

    expect(findings.map((finding) => finding.path)).toEqual([`${probe}:1`, `${probe}:5`]);
  });

  test("accepts a registered exception at its file, and rejects its id elsewhere and an unknown id", () => {
    const other = "packages/domain/src/shared-kernel/exception-probe-other.ts";

    expect(
      probeFindings({ [registry]: withEntry(probeEntry), [probe]: registeredSuppression }),
    ).toEqual([]);

    const findings = probeFindings(
      {
        [registry]: withEntry(probeEntry),
        [probe]: registeredSuppression,
        [other]: `// ${id} and EX-9002 name exceptions that this file does not hold.\nexport const otherValue = 1;\n`,
      },
      [probe, other],
    );

    expect(findings).toEqual([
      { path: `${other}:1`, message: expect.stringContaining(id) },
      { path: `${other}:1`, message: expect.stringContaining("EX-9002") },
    ]);
  });

  test("rejects an entry that its files no longer name, and a rule that no site suppresses", () => {
    const findings = probeFindings({
      [registry]: withEntry({ ...probeEntry, owner: "apps/backend" }),
      [probe]: "export const probeUrl = new URL(window.location.href);\n",
    });

    expect(findings).toEqual([
      { path: registry, message: expect.stringContaining("effect/no-cross-runtime") },
      { path: registry, message: expect.stringContaining("outside its owner apps/backend") },
      { path: registry, message: expect.stringContaining(`where no comment names ${id}`) },
    ]);
  });

  test("requires the exception id of a leaking expectation in its JSDoc block, before the tag", () => {
    const entry: EffectException = {
      ...probeEntry,
      rules: ["FX006", "effecttsgo/leaking-requirements"],
    };

    const service = (doc: string) =>
      `/**\n${doc}\n */\nexport const probeUrl = "a service that leaks Database";\n`;

    expect(
      probeFindings({
        [registry]: withEntry(entry),
        [probe]: service(` * Exception ${id}.\n *\n * @effect-expect-leaking Database`),
      }),
    ).toEqual([]);

    expect(
      probeFindings({ [probe]: service(" * @effect-expect-leaking Database") }).map(
        (finding) => finding.path,
      ),
    ).toEqual([`${probe}:2`]);

    expect(
      probeFindings({
        [registry]: withEntry(entry),
        [probe]: service(` * @effect-expect-leaking Database ${id}`),
      }),
    ).toEqual([{ path: `${probe}:2`, message: expect.stringContaining("reads it as a service") }]);
  });

  test("requires the exception id of an allow directive of the Oxlint Effect plugin", () => {
    const entry: EffectException = { ...probeEntry, rules: ["FX011", "effect/no-ambient-console"] };

    const directive = "// oxlint-effect-plugin allow(no-ambient-console): dev only:";
    const report = 'export const probeUrl = console.info("the probe reports");\n';

    expect(
      probeFindings({
        [registry]: withEntry(entry),
        [probe]: `${directive} ${id}: the probe reports\n${report}`,
      }),
    ).toEqual([]);

    expect(probeFindings({ [probe]: `${directive} the probe reports\n${report}` })).toEqual([
      { path: `${probe}:1`, message: expect.stringContaining("effect/no-ambient-console") },
    ]);
  });

  test("reopens an entry when package.json pins another version than the one examined", () => {
    const files = { [registry]: withEntry(probeEntry), [probe]: registeredSuppression };

    expect(probeFindings(files)).toEqual([]);

    const upgraded = base
      .read("package.json")
      .replace(`"effect": "${effectVersion}"`, '"effect": "9.9.9"');

    expect(probeFindings({ ...files, "package.json": upgraded })).toEqual([
      { path: registry, message: expect.stringContaining(`effect ${effectVersion}`) },
    ]);
  });
});
