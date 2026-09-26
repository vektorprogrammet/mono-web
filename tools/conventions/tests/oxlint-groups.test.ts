// Oxlint override globs do not support extglob, and an override that matches no file fails
// silently: the Effect domain groups once used `!(…)` patterns and no core rule ever ran.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import config from "../../../oxlint.config.ts";
import { repositoryRoot } from "../src/repository.js";

const root = repositoryRoot(import.meta.dir);

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((path) => path.length > 0);

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
    expect(effectRulesFor("packages/sdk/src/probe.ts")).toContain("effect/no-ambient-authority");
    expect(effectRulesFor("packages/database/src/probe.ts")).toContain("effect/no-ambient-console");
    expect(effectRulesFor("apps/backend/src/probe.ts")).toContain("effect/no-ambient-console");
  });

  test("core sources run the strict rules, and the adapters decode external data", () => {
    expect(effectRulesFor("packages/domain/src/probe.ts")).toContain("effect/no-untyped-throw");
    expect(effectRulesFor("packages/sdk/src/probe.ts")).toContain(
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
