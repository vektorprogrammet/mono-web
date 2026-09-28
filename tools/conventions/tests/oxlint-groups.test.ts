// Oxlint override globs do not support extglob, and an override that matches no file fails
// silently: the Effect domain groups once used `!(…)` patterns and no core rule ever ran.
import { correctness, effectNative, presets, recommended } from "@effect/tsgo/oxlint-presets";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import config from "../../../oxlint.config.ts";
import { ConventionsPlatform } from "../src/cli.js";
import { repositoryRoot } from "../src/repository.js";

const tracked = await Effect.runPromise(
  Effect.gen(function* () {
    const root = yield* repositoryRoot(import.meta.dir);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* spawner.string(ChildProcess.make("git", ["ls-files", "-z"], { cwd: root }));
  }).pipe(Effect.provide(ConventionsPlatform)),
).then((listed) => listed.split("\0").filter((path) => path.length > 0));

const overrides = config.overrides ?? [];

const matches = (pattern: string, path: string) => new Bun.Glob(pattern).match(path);

// Oxlint applies matching overrides in order; a later override replaces an earlier rule setting.
const effectRulesFor = (path: string) => {
  const enabled = new Set<string>();

  for (const override of overrides) {
    if (!override.files.some((pattern) => matches(pattern, path))) continue;

    for (const [rule, setting] of Object.entries(override.rules ?? {})) {
      if (!rule.startsWith("effect/")) continue;

      if (setting === "off") enabled.delete(rule);
      else enabled.add(rule);
    }
  }

  return [...enabled].sort();
};

describe("oxlint override globs", () => {
  test("use no extglob syntax", () => {
    const extglob = /[!?+*@]\(/;

    const offending = overrides.flatMap((override) =>
      override.files.filter((pattern) => extglob.test(pattern)),
    );

    expect(offending).toEqual([]);
  });

  test("each match at least one tracked file", () => {
    const empty = overrides.flatMap((override) =>
      override.files.filter((pattern) => !tracked.some((path) => matches(pattern, path))),
    );

    expect(empty).toEqual([]);
  });
});

describe("Effect domain groups", () => {
  test("core sources receive their role's rules", () => {
    expect(effectRulesFor("packages/domain/src/probe.ts")).toContain("effect/no-ambient-authority");
    expect(effectRulesFor("packages/rpc/src/client.ts")).toContain("effect/no-ambient-authority");
    expect(effectRulesFor("packages/database/src/probe.ts")).toContain("effect/no-ambient-console");
    expect(effectRulesFor("apps/backend/src/probe.ts")).toContain("effect/no-ambient-console");
  });

  test("core sources run the strict rules, and the adapters decode external data", () => {
    expect(effectRulesFor("packages/domain/src/probe.ts")).toContain("effect/no-untyped-throw");
    expect(effectRulesFor("packages/rpc/src/client.ts")).toContain(
      "effect/no-native-promise-control-flow",
    );
    expect(effectRulesFor("packages/database/src/probe.ts")).toContain(
      "effect/no-native-promise-control-flow",
    );
    expect(effectRulesFor("apps/backend/src/probe.ts")).toContain("effect/no-raw-json-parse");
    expect(effectRulesFor("packages/database/src/probe.ts")).toContain("effect/no-raw-json-parse");
  });

  test("tests do not inherit library rules from the broader source group", () => {
    expect(effectRulesFor("packages/domain/src/probe.test.ts")).not.toContain(
      "effect/no-ambient-authority",
    );
    expect(effectRulesFor("packages/domain/src/probe.test.ts")).toEqual(
      effectRulesFor("tools/verification/probe.test.ts"),
    );
  });

  // `totalOverrides` gives each group's override every plugin rule, where `off` marks a rule that
  // does not apply to the group's role; any other override that sets a plugin rule `off` disables it.
  test("relax no rule", () => {
    const pluginRules = new Set(
      overrides.flatMap((override) =>
        Object.keys(override.rules ?? {}).filter((rule) => rule.startsWith("effect/")),
      ),
    );

    const relaxed = overrides.flatMap((override) => {
      const settings = Object.entries(override.rules ?? {}).filter(([rule]) =>
        pluginRules.has(rule),
      );

      const group = settings.length === pluginRules.size;

      const relaxes = settings.some(([, setting]) => {
        const severity = Array.isArray(setting) ? setting[0] : setting;

        return severity === "warn" || (!group && severity === "off");
      });

      return relaxes ? override.files : [];
    });

    expect(relaxed).toEqual([]);
  });
});

// `rules` sets a rule for every file, and each matching override replaces the setting in order.
const settingsFor = (path: string) =>
  new Map(
    [
      config.rules,
      ...overrides
        .filter((override) => override.files.some((pattern) => matches(pattern, path)))
        .map((override) => override.rules),
    ].flatMap((rules) => Object.entries(rules ?? {})),
  );

describe("Effect language-service rules", () => {
  // Every rule of every preset the package ships, so an upgrade that adds a rule or a category
  // is an error at once, not a rule that never runs.
  const shippedRules = [
    ...new Set(Object.values(presets).flatMap((preset) => Object.keys(preset.rules ?? {}))),
  ].sort();

  // The React applications keep the recommended and correctness rules, less effectNative.
  const reactApplicationRules = new Set(
    [recommended, correctness]
      .flatMap((preset) => Object.keys(preset.rules ?? {}))
      .filter((rule) => !Object.hasOwn(effectNative.rules ?? {}, rule)),
  );

  const notErrorsAt = (path: string) => {
    const settings = settingsFor(path);

    return shippedRules.filter((rule) => {
      const setting = settings.get(rule);

      return (Array.isArray(setting) ? setting[0] : setting) !== "error";
    });
  };

  test("the package ships the presets the configuration names", () => {
    expect(Object.keys(presets).sort()).toEqual([
      "antipattern",
      "correctness",
      "effectNative",
      "recommended",
      "style",
    ]);
  });

  test("are all errors outside the React applications and the entry points", () => {
    for (const path of [
      "packages/domain/src/probe.ts",
      "packages/database/src/probe.ts",
      "packages/rpc/src/probe.ts",
      "apps/backend/src/probe.ts",
      "apps/docs/src/probe.tsx",
      "tools/scripts/probe.ts",
      "tools/conventions/src/probe.ts",
    ]) {
      expect({ path, notErrors: notErrorsAt(path) }).toEqual({ path, notErrors: [] });
    }
  });

  test("leave only Effect.provide to the entry points", () => {
    for (const path of [
      "packages/database/src/probe.test.ts",
      "packages/database/src/probe-main.ts",
      "apps/backend/src/main.ts",
      "apps/backend/src/test/probe.ts",
      "tools/acceptance/probe.ts",
      "tools/verification/probe.ts",
      "tools/e2e/probe.ts",
    ]) {
      expect({ path, notErrors: notErrorsAt(path) }).toEqual({
        path,
        notErrors: ["effecttsgo/strict-effect-provide"],
      });
    }
  });

  test("keep the recommended and correctness rules in the React applications", () => {
    const off = shippedRules.filter((rule) => !reactApplicationRules.has(rule));

    for (const path of [
      "apps/dashboard/app/probe.tsx",
      "apps/dashboard/e2e/probe.spec.ts",
      "apps/homepage/src/probe.tsx",
    ]) {
      expect({ path, notErrors: notErrorsAt(path) }).toEqual({ path, notErrors: off });
    }
  });

  test("are relaxed only for the React applications, and Effect.provide for the entry points", () => {
    const relaxations = overrides.flatMap((override) => {
      const rules = Object.entries(override.rules ?? {})
        .filter(
          ([rule, setting]) =>
            rule.startsWith("effecttsgo/") &&
            (Array.isArray(setting) ? setting[0] : setting) !== "error",
        )
        .map(([rule]) => rule);

      return rules.length === 0 ? [] : [{ files: override.files, rules }];
    });

    expect(relaxations.map(({ files }) => files.includes("apps/dashboard/**"))).toEqual([
      false,
      true,
    ]);
    expect(relaxations[0]?.rules).toEqual(["effecttsgo/strict-effect-provide"]);
    expect(relaxations[1]?.files).toEqual(["apps/homepage/**", "apps/dashboard/**"]);
  });
});
