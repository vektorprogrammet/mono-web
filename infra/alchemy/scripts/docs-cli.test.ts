import { describe, expect, test } from "bun:test";
import {
  DocsCliUsageError,
  executeDocsCli,
  parseDocsCommand,
  rejectAmbientDocsSelectors,
  type SpawnSync,
} from "./docs-cli.ts";

const selection = ["--stage", "docs-dev-main", "--profile", "goal1-staging"] as const;

describe("docs deployment selection", () => {
  test("accepts only the dedicated state and provider selection", () => {
    expect(parseDocsCommand(["state", ...selection])).toEqual({
      command: "state",
      stage: "docs-dev-main",
      profile: "goal1-staging",
      confirmed: false,
    });
    expect(parseDocsCommand(["plan", "--", ...selection])).toEqual({
      command: "plan",
      stage: "docs-dev-main",
      profile: "goal1-staging",
      confirmed: false,
    });
    expect(parseDocsCommand(["deploy", ...selection, "--yes"])).toEqual({
      command: "deploy",
      stage: "docs-dev-main",
      profile: "goal1-staging",
      confirmed: true,
    });
  });

  test("rejects the apex stage and another profile", () => {
    expect(() =>
      parseDocsCommand(["plan", "--stage", "dev-main", "--profile", "goal1-staging"]),
    ).toThrow(DocsCliUsageError);
    expect(() =>
      parseDocsCommand(["plan", "--stage", "docs-dev-main", "--profile", "default"]),
    ).toThrow(DocsCliUsageError);
  });

  test("requires explicit deploy confirmation", () => {
    expect(() => parseDocsCommand(["deploy", ...selection])).toThrow(DocsCliUsageError);
    expect(() => parseDocsCommand(["plan", ...selection, "--yes"])).toThrow(DocsCliUsageError);
  });

  test("rejects ambient deployment selectors", () => {
    expect(() => rejectAmbientDocsSelectors({ ALCHEMY_STAGE: "dev-main" })).toThrow(
      DocsCliUsageError,
    );
  });
});

describe("docs deployment process boundary", () => {
  test("delegates the plan and build ownership to the docs entrypoint", () => {
    const calls: Array<{
      readonly file: string;
      readonly args: string[];
      readonly env: NodeJS.ProcessEnv;
    }> = [];
    const spawn: SpawnSync = (file, args, options) => {
      calls.push({ file, args, env: options.env });
      return { status: 0 };
    };

    expect(
      executeDocsCli(["plan", ...selection], {
        env: {},
        spawn,
        standaloneDirectory: "/repo/infra/alchemy",
      }),
    ).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: "/repo/infra/alchemy/node_modules/.bin/alchemy",
      args: ["plan", "docs.run.ts", "--stage", "docs-dev-main", "--profile", "goal1-staging"],
    });
    expect(calls[0]?.env.ALCHEMY_TELEMETRY_DISABLED).toBe("1");
  });

  test("reads only the dedicated local state metadata", () => {
    const calls: Array<readonly string[]> = [];
    const spawn: SpawnSync = (_file, args) => {
      calls.push(args);
      return { status: 0 };
    };

    expect(
      executeDocsCli(["state", ...selection], {
        env: {},
        spawn,
        standaloneDirectory: "/repo/infra/alchemy",
      }),
    ).toBe(0);
    expect(calls).toEqual([
      ["state", "stacks", "docs.run.ts", "--profile", "goal1-staging", "--local"],
      [
        "state",
        "stages",
        "docs.run.ts",
        "--stack",
        "vektor-docs",
        "--profile",
        "goal1-staging",
        "--local",
      ],
    ]);
  });
});
