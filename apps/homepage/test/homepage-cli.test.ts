import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertApexLocalState,
  executeHomepageCli,
  parseHomepageCommand,
  type SpawnSync,
} from "../../../infra/alchemy/scripts/homepage-cli";

const validEnvironment = { PATH: "/usr/bin", HOME: "/tmp" };
const logicalIds = ["vektor-apex-dashboard", "vektor-apex-homepage", "vektor-apex-worker"] as const;

function writeApexStateFixture(
  standaloneRoot: string,
  options: { readonly crossWireDashboard?: boolean; readonly omitApiRoute?: boolean } = {},
): string {
  const directory = resolve(standaloneRoot, ".alchemy/state/vektor/dev-main");
  mkdirSync(directory, { recursive: true });
  const workerNames = {
    "vektor-apex-dashboard": "vektor-vektor-apex-dashboard-dev-main-2222222222222222",
    "vektor-apex-homepage": "vektor-vektor-apex-homepage-dev-main-1111111111111111",
    "vektor-apex-worker": "vektor-vektor-apex-worker-dev-main-3333333333333333",
  };
  writeFileSync(
    resolve(directory, "__stack_output__.json"),
    JSON.stringify({
      app: "vektor",
      stage: "dev-main",
      target: "apex-preview",
      hostname: "vektor.phibkro.org",
      apiHostname: "api.vektor.phibkro.org",
      previewStage: "dev-main",
      backendHostname: "origin-api.vektor.phibkro.org",
      url: "https://vektor.phibkro.org",
      backendOrigin: "https://origin-api.vektor.phibkro.org",
      stateDirectory: ".alchemy",
      forbiddenHost: "vektorprogrammet.no",
    }),
  );
  for (const [index, logicalId] of logicalIds.entries()) {
    const workerName =
      logicalId === "vektor-apex-dashboard" && options.crossWireDashboard === true
        ? workerNames["vektor-apex-homepage"]
        : workerNames[logicalId];
    writeFileSync(
      resolve(directory, `${logicalId}.json`),
      JSON.stringify({
        fqn: logicalId,
        logicalId,
        instanceId: String(index + 1).repeat(32),
        resourceType: "Cloudflare.Worker",
        props: {
          isExternal: true,
          ...(logicalId === "vektor-apex-worker"
            ? {
                env: {
                  Homepage: {
                    workerId: workerNames["vektor-apex-homepage"],
                    workerName: workerNames["vektor-apex-homepage"],
                  },
                  Dashboard: {
                    workerId: workerNames["vektor-apex-dashboard"],
                    workerName: workerNames["vektor-apex-dashboard"],
                  },
                },
              }
            : {}),
        },
        attr: {
          workerId: workerName,
          workerName,
          accountId: "a".repeat(32),
          tags: ["alchemy:stack:vektor", "alchemy:stage:dev-main", `alchemy:id:${logicalId}`],
          ...(logicalId === "vektor-apex-worker"
            ? {
                url: "https://vektor.phibkro.org",
                domain: { name: "vektor.phibkro.org", aliases: [] },
                routes:
                  options.omitApiRoute === true
                    ? []
                    : [
                        {
                          id: "c".repeat(32),
                          pattern: "api.vektor.phibkro.org/*",
                          zoneId: "b".repeat(32),
                        },
                      ],
              }
            : {}),
        },
        removalPolicy: "destroy",
        providerMode: "live",
      }),
    );
  }
  return directory;
}

const standaloneDirectory = mkdtempSync(join(tmpdir(), "mono-web-alchemy-"));
writeApexStateFixture(standaloneDirectory);
afterAll(() => rmSync(standaloneDirectory, { recursive: true, force: true }));

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

it("fails closed when the dev-main local state directory is absent", () => {
  expect(() => assertApexLocalState(resolve(standaloneDirectory, "missing"))).toThrow(
    "missing apex local state directory",
  );
});

it("rejects an extra local state JSON record", () => {
  const root = mkdtempSync(join(tmpdir(), "mono-web-alchemy-extra-"));
  try {
    const directory = writeApexStateFixture(root);
    writeFileSync(resolve(directory, "unowned-worker.json"), "{}");
    expect(() => assertApexLocalState(root)).toThrow("file set mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a missing local stack output", () => {
  const root = mkdtempSync(join(tmpdir(), "mono-web-alchemy-output-"));
  try {
    const directory = writeApexStateFixture(root);
    rmSync(resolve(directory, "__stack_output__.json"));
    expect(() => assertApexLocalState(root)).toThrow("file set mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects a cross-wired logical ID and physical Worker", () => {
  const root = mkdtempSync(join(tmpdir(), "mono-web-alchemy-cross-wire-"));
  try {
    writeApexStateFixture(root, { crossWireDashboard: true });
    expect(() => assertApexLocalState(root)).toThrow("identity mismatch: vektor-apex-dashboard");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects local state without the recovered API route", () => {
  const root = mkdtempSync(join(tmpdir(), "mono-web-alchemy-api-route-"));
  try {
    writeApexStateFixture(root, { omitApiRoute: true });
    expect(() => assertApexLocalState(root)).toThrow("binding identity mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      argv: ["plan", "--stage", "p20", "--profile", "alice"],
      expected: ["plan", "alchemy.run.ts", "--stage", "p20", "--profile", "alice"],
      expectedDashboardMount: undefined,
    },
    {
      argv: ["deploy", "--stage", "dev-main", "--profile", "alice", "--yes"],
      expected: ["deploy", "alchemy.run.ts", "--stage", "dev-main", "--profile", "alice", "--yes"],
      expectedDashboardMount: "/",
    },
    {
      argv: ["destroy", "--stage", "p999", "--profile", "alice", "--dry-run"],
      expected: ["destroy", "alchemy.run.ts", "--stage", "p999", "--profile", "alice", "--dry-run"],
      expectedDashboardMount: undefined,
    },
  ])(
    "passes only stage-specific build inputs, explicit argv, and telemetry-disabled env to Alchemy",
    ({ argv, expected, expectedDashboardMount }) => {
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
          ...(expectedDashboardMount === undefined
            ? {}
            : { DASHBOARD_MOUNT: expectedDashboardMount }),
        },
      });
      expect(alchemyCall?.env.DASHBOARD_MOUNT).toBe(expectedDashboardMount);
      expect(alchemyCall?.file).toBe(`${standaloneDirectory}/node_modules/.bin/alchemy`);
    },
  );

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
