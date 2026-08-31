import { describe, expect, it } from "vitest";
import { assertDisposablePostgresUrl, departmentEntityIdFor } from "./preview-scenario";

describe("representative preview scenario", () => {
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
