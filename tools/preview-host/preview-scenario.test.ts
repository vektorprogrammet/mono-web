import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  assertDisposablePostgresUrl,
  assertUniqueContactDepartmentSlugs,
  departmentEntityIdFor,
  stopPreviewScenarioBackend,
} from "./preview-scenario";

describe("representative preview scenario", () => {
  it("confirms owned backend exit even when graceful termination is ignored", async () => {
    const child = spawn("bun", [
      "-e",
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    ]);

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
      });
      await stopPreviewScenarioBackend(child);
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);

  it("rejects public slug collisions after normalization, but ignores inactive departments", () => {
    expect(() =>
      assertUniqueContactDepartmentSlugs([
        { shortName: "Trondheim", active: true },
        { shortName: " TRONDHEIM ", active: true },
      ]),
    ).toThrow("duplicate active contact department slug");
    expect(() =>
      assertUniqueContactDepartmentSlugs([
        { shortName: "Trondheim", active: true },
        { shortName: "Trondheim", active: false },
      ]),
    ).not.toThrow();
  });

  it("derives the same native department identifier as Organization administration", () => {
    expect(departmentEntityIdFor("preview-0072-dept-ntnu-cmd")).toBe(
      "department-1fb4bbbfbcd6ce8960504c4b22ce84f0b6dd7c579de91f6b3858347991fa0177",
    );
  });

  it.each([
    "postgres://postgres@127.0.0.1:5435/preview_scenario",
    "postgresql://postgres@localhost:5435/scenario_test",
  ])("accepts disposable loopback PostgreSQL: %s", (url) => {
    expect(() => assertDisposablePostgresUrl(url)).not.toThrow();
  });

  it.each([
    "https://127.0.0.1/preview_scenario",
    "postgres://postgres@database.internal/preview_scenario",
    "postgres://postgres@127.0.0.1:5434/preview_scenario",
    "postgres://postgres@127.0.0.1:5435/postgres",
    "postgres://postgres@vektorprogrammet.no/preview_scenario",
  ])("rejects a non-disposable database target: %s", (url) => {
    expect(() => assertDisposablePostgresUrl(url)).toThrow();
  });
});
