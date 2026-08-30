import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeHomepageCli,
  parseHomepageCommand,
  type SpawnSync,
} from "../../../infra/alchemy/scripts/homepage-cli";

const validEnvironment = { PATH: "/usr/bin", HOME: "/tmp" };
const standaloneDirectory = "/tmp/mono-web-alchemy";

function captureSpawn() {
  const calls: Array<{
    file: string;
    args: string[];
    cwd: string;
    env: Record<string, string | undefined>;
  }> = [];
  const spawn: SpawnSync = (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd, env: options.env });
    return { status: 0 };
  };
  return { calls, spawn };
}

describe("homepage provider wrapper", () => {
  it.each(["default", "DEFAULT", "DeFaUlT"])(
    "rejects profile %s before spawning for every cloud command",
    (profile) => {
      const { spawn, calls } = captureSpawn();
      for (const [command, confirmation] of [
        ["plan", []],
        ["deploy", ["--yes"]],
        ["destroy", ["--dry-run"]],
      ] as const) {
        expect(() =>
          executeHomepageCli([command, "--stage", "p001", "--profile", profile, ...confirmation], {
            env: validEnvironment,
            spawn,
            standaloneDirectory,
          }),
        ).toThrow("reserved default profile");
      }
      expect(calls).toEqual([]);
    },
  );

  it("rejects the p000 guard before ambient-selector checks and spawn", () => {
    const { spawn, calls } = captureSpawn();
    expect(() =>
      executeHomepageCli(["guard", "--stage", "p000"], {
        env: { ...validEnvironment, ALCHEMY_PROFILE: "ambient" },
        spawn,
        standaloneDirectory,
      }),
    ).toThrow("p000 is reserved");
    expect(calls).toEqual([]);
  });

  it.each([
    {
      argv: ["plan", "--stage", "p001", "--profile", "alice"],
      expected: ["plan", "alchemy.run.ts", "--stage", "p001", "--profile", "alice"],
    },
    {
      argv: ["deploy", "--stage", "dev-main", "--profile", "alice", "--yes"],
      expected: ["deploy", "alchemy.run.ts", "--stage", "dev-main", "--profile", "alice", "--yes"],
    },
    {
      argv: ["destroy", "--stage", "p999", "--profile", "alice", "--dry-run"],
      expected: ["destroy", "alchemy.run.ts", "--stage", "p999", "--profile", "alice", "--dry-run"],
    },
  ])("passes only explicit argv and telemetry-disabled env to Alchemy", ({ argv, expected }) => {
    const { spawn, calls } = captureSpawn();
    expect(
      executeHomepageCli(argv, {
        env: validEnvironment,
        spawn,
        standaloneDirectory,
      }),
    ).toBe(0);
    expect(calls).toHaveLength(argv[0] === "deploy" ? 2 : 1);
    if (argv[0] === "deploy") {
      expect(calls[0]).toMatchObject({
        file: process.execPath,
        args: ["run", "--cwd", resolve(standaloneDirectory, "../..", "packages/sdk"), "build"],
        cwd: standaloneDirectory,
      });
    }
    const alchemyCall = calls.at(-1);
    expect(alchemyCall).toMatchObject({
      args: expected,
      cwd: standaloneDirectory,
      env: {
        ...validEnvironment,
        ALCHEMY_TELEMETRY_DISABLED: "1",
      },
    });
    expect(alchemyCall?.file).toBe(`${standaloneDirectory}/node_modules/.bin/alchemy`);
  });

  it("forwards Cloudflare credentials without treating them as target selectors", () => {
    const { spawn, calls } = captureSpawn();
    const credentials = {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_API_TOKEN: "token",
    };

    expect(
      executeHomepageCli(["deploy", "--stage", "p020", "--profile", "preview", "--yes"], {
        env: { ...validEnvironment, ...credentials },
        spawn,
        standaloneDirectory,
      }),
    ).toBe(0);
    expect(calls.at(-1)?.env).toMatchObject(credentials);
  });

  it("does not deploy when the SDK build fails", () => {
    const calls: string[][] = [];
    const spawn: SpawnSync = (_file, args) => {
      calls.push(args);
      return { status: 2 };
    };

    expect(
      executeHomepageCli(["deploy", "--stage", "dev-main", "--profile", "preview", "--yes"], {
        env: validEnvironment,
        spawn,
        standaloneDirectory,
      }),
    ).toBe(2);
    expect(calls).toEqual([
      ["run", "--cwd", resolve(standaloneDirectory, "../..", "packages/sdk"), "build"],
    ]);
  });

  it("still rejects ambient deployment target selectors", () => {
    const { spawn, calls } = captureSpawn();
    expect(() =>
      executeHomepageCli(["plan", "--stage", "p020", "--profile", "preview"], {
        env: { ...validEnvironment, ALCHEMY_PROFILE: "ambient" },
        spawn,
        standaloneDirectory,
      }),
    ).toThrow("ambient selector 'ALCHEMY_PROFILE'");
    expect(calls).toEqual([]);
  });

  const invalidArgvCases = [
    ["guard", "--stage", "p000", "--profile", "alice"],
    ["plan", "--stage", "p001", "--profile", "alice", "--yes"],
    ["deploy", "--stage", "p001", "--profile", "alice"],
    ["destroy", "--stage", "p001", "--profile", "alice"],
    ["plan", "--stage=p001", "--profile", "alice"],
    ["plan", "--stage", "p001", "--profile", "alice", "--adopt"],
    ["plan", "--stage", "p001", "--profile", "alice", "--env-file", "vars"],
  ] as const;
  it.each(invalidArgvCases.map((argv) => ({ argv })))(
    "rejects unsupported grammar %j",
    ({ argv }) => {
      expect(() => parseHomepageCommand(argv)).toThrow();
    },
  );
});
