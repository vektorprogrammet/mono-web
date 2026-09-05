import { describe, expect, it } from "vitest";
import {
  assertDisposablePostgresUrl,
  assertPreviewScenarioCompatibility,
  assertUniqueContactDepartmentSlugs,
  departmentEntityIdFor,
  makePreviewScenarioEnvironment,
  nativePreviewDepartments,
  previewScenarioManifest,
} from "./preview-scenario";

describe("representative preview scenario", () => {
  it("keeps imported Trondheim contact identity distinct from native administration demo", () => {
    expect(() =>
      assertUniqueContactDepartmentSlugs([
        { shortName: "Trondheim", active: true },
        ...nativePreviewDepartments.map((department) => ({ ...department, active: true })),
      ]),
    ).not.toThrow();
    expect(previewScenarioManifest.departmentId).toBe("1");
    expect(nativePreviewDepartments[0].name).toContain("Syntetisk");
    expect(nativePreviewDepartments[0].id).not.toBe("preview-0072-dept-ntnu-cmd");
    expect(previewScenarioManifest.commandIds.recruitmentTeam).not.toBe(
      "preview-0072-team-rekruttering-command",
    );
  });

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

  it.each([
    [false, false],
    [true, true],
  ])("allows empty or compatible revised schema (tables: %s/%s)", async (departments, receipts) => {
    let calls = 0;
    await assertPreviewScenarioCompatibility({
      query: async () => {
        calls += 1;
        return calls === 1 ? { rows: [{ departments, receipts }] } : { rowCount: 0, rows: [] };
      },
    });
    expect(calls).toBe(1 + Number(departments) + Number(receipts));
  });

  it.each(["department", "receipt"])(
    "rejects previous scenario %s using reads only",
    async (marker) => {
      let calls = 0;
      await expect(
        assertPreviewScenarioCompatibility({
          query: async (statement: string) => {
            expect(statement.trimStart()).toMatch(/^SELECT\s/u);
            calls += 1;
            if (calls === 1) return { rows: [{ departments: true, receipts: true }] };
            return { rowCount: marker === "department" || calls === 3 ? 1 : 0 };
          },
        }),
      ).rejects.toThrow("incompatible pre-0092 preview scenario; no mutation performed");
      expect(calls).toBe(marker === "department" ? 2 : 3);
    },
  );

  it("does not mistake failed inspection for a fresh database", async () => {
    await expect(
      assertPreviewScenarioCompatibility({
        query: async () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toThrow("database unavailable");
  });

  it("derives the same native department identifier as Organization administration", () => {
    expect(departmentEntityIdFor("preview-0072-dept-ntnu-cmd")).toBe(
      "department-1fb4bbbfbcd6ce8960504c4b22ce84f0b6dd7c579de91f6b3858347991fa0177",
    );
  });

  it("composes the exact dev-main identity policy without legacy aliases", () => {
    const environment = makePreviewScenarioEnvironment({
      PREVIEW_SCENARIO_TEST_MARKER: "retained",
      BETTER_AUTH_URL: "",
      BETTER_AUTH_TRUSTED_ORIGINS: "https://legacy.example.invalid",
    });

    expect(environment).toMatchObject({
      PREVIEW_SCENARIO_TEST_MARKER: "retained",
      NATIVE_IDENTITY_DEPLOYMENT: "preview",
      NATIVE_IDENTITY_TRUSTED_ORIGINS: '["https://vektor.phibkro.org"]',
      OAUTH_CANONICAL_ORIGIN: "https://vektor.phibkro.org",
      OAUTH_DASHBOARD_ORIGIN: "https://vektor.phibkro.org",
      OAUTH_NATIVE_API_RESOURCE: "urn:vektorprogrammet:native-api",
    });
    expect(environment).not.toHaveProperty("BETTER_AUTH_URL");
    expect(environment).not.toHaveProperty("BETTER_AUTH_TRUSTED_ORIGINS");
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
