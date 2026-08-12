import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEV_CONTENT,
  DEV_CONTENT_SOURCE,
  DEV_ROUTE_CENSUS,
  getDevTeamMembers,
} from "../src/lib/dev-content";
import {
  ROUTE_SOURCE_ROOTS,
  buildHomepageDigestInputs,
  buildRouteSourceManifest,
  canonicalJson as implementationCanonicalJson,
  computeContentDigest,
  computeRouteDigest,
} from "../vite-digests";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function independentCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => independentCanonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${independentCanonicalJson(entry)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Unsupported undefined digest value");
  return serialized;
}

function independentDigest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(`${independentCanonicalJson(value)}\n`, "utf8")
    .digest("hex")}`;
}

describe("DEV CONTENT contract", () => {
  it("keeps one typed, local, synthetic content source", () => {
    expect(DEV_CONTENT_SOURCE).toBe("dev-content");
    expect(DEV_CONTENT.sponsors.length).toBeGreaterThan(0);
    expect(DEV_CONTENT.teams.length).toBeGreaterThan(0);
    expect(DEV_CONTENT.departments.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(DEV_CONTENT);
    expect(serialized).not.toMatch(/vektorprogrammet\.no|railway|api[_-]?url/i);
    for (const sponsor of DEV_CONTENT.sponsors) {
      expect(sponsor.image).toMatch(/^\//);
      expect(sponsor.href).toMatch(/^https:\/\/example\.invalid\//);
    }
    for (const team of DEV_CONTENT.teams) {
      expect(team.url).toMatch(/^\//);
      expect(team.image).toMatch(/^\//);
      expect(team.email).toMatch(/@example\.invalid$/);
      expect(getDevTeamMembers(team.id)).toHaveLength(team.numberOfMembers);
    }
    for (const department of DEV_CONTENT.departments) {
      expect(department.image).toMatch(/^\//);
      expect(department.email).toMatch(/@example\.invalid$/);
      expect(
        department.contacts.every((contact) => contact.mail.endsWith("@example.invalid")),
      ).toBe(true);
    }
  });

  it("derives a complete deterministic route and people census", () => {
    expect(new Set(DEV_ROUTE_CENSUS.paths).size).toBe(DEV_ROUTE_CENSUS.paths.length);
    expect(DEV_ROUTE_CENSUS.paths).toContain("/");
    expect(DEV_ROUTE_CENSUS.paths).toContain("/team");
    expect(DEV_ROUTE_CENSUS.paths).toContain("/kontakt/trondheim");
    expect(DEV_ROUTE_CENSUS.teams.map(({ id }) => id)).toEqual([
      "aas-evaluering",
      "aas-skole",
      "aas-sosialt",
      "aas-sponsor",
      "aas-styre",
      "bergen-rekruttering",
      "bergen-skole",
      "bergen-styre",
      "hovedstyret",
      "trondheim-evaluering",
      "trondheim-it",
      "trondheim-okonomi",
      "trondheim-profilering",
      "trondheim-rekruttering",
      "trondheim-skole",
      "trondheim-sponsor",
      "trondheim-styre",
    ]);
    expect(DEV_ROUTE_CENSUS.departments.map(({ id }) => id)).toEqual([
      "aas",
      "bergen",
      "hovedstyret",
      "trondheim",
    ]);
    expect(DEV_ROUTE_CENSUS.people.map(({ id }) => id)).toEqual([
      "aas-evaluering-member-1",
      "aas-evaluering-member-2",
      "aas-skole-member-1",
      "aas-skole-member-2",
      "aas-sosialt-member-1",
      "aas-sosialt-member-2",
      "aas-sponsor-member-1",
      "aas-sponsor-member-2",
      "aas-styre-member-1",
      "aas-styre-member-2",
      "aas-styre-member-3",
      "bergen-rekruttering-member-1",
      "bergen-rekruttering-member-2",
      "bergen-skole-member-1",
      "bergen-skole-member-2",
      "bergen-styre-member-1",
      "bergen-styre-member-2",
      "hovedstyret-member-1",
      "hovedstyret-member-2",
      "hovedstyret-member-3",
      "hovedstyret-member-4",
      "trondheim-evaluering-member-1",
      "trondheim-evaluering-member-2",
      "trondheim-evaluering-member-3",
      "trondheim-it-member-1",
      "trondheim-it-member-2",
      "trondheim-okonomi-member-1",
      "trondheim-okonomi-member-2",
      "trondheim-profilering-member-1",
      "trondheim-profilering-member-2",
      "trondheim-rekruttering-member-1",
      "trondheim-rekruttering-member-2",
      "trondheim-rekruttering-member-3",
      "trondheim-skole-member-1",
      "trondheim-skole-member-2",
      "trondheim-sponsor-member-1",
      "trondheim-sponsor-member-2",
      "trondheim-styre-member-1",
      "trondheim-styre-member-2",
      "trondheim-styre-member-3",
      "trondheim-styre-member-4",
    ]);
    expect(DEV_ROUTE_CENSUS.paths).toEqual([...DEV_ROUTE_CENSUS.paths].sort());

    for (const team of DEV_CONTENT.teams) {
      expect(DEV_ROUTE_CENSUS.paths).toContain(team.url);
      expect(DEV_ROUTE_CENSUS.teams).toContainEqual({
        id: team.id,
        path: team.url,
        memberCount: team.numberOfMembers,
      });
    }
    for (const department of DEV_CONTENT.departments) {
      expect(DEV_ROUTE_CENSUS.paths).toContain(`/kontakt/${department.id}`);
      expect(DEV_ROUTE_CENSUS.departments).toContainEqual({
        id: department.id,
        path: `/kontakt/${department.id}`,
        memberCount: department.members,
        contacts: department.contacts,
      });
    }

    const expectedPeople = DEV_CONTENT.teams.reduce(
      (total, team) => total + team.numberOfMembers,
      0,
    );
    expect(DEV_ROUTE_CENSUS.people).toHaveLength(expectedPeople);
    expect(new Set(DEV_ROUTE_CENSUS.people.map((person) => person.id)).size).toBe(expectedPeople);
    expect(DEV_ROUTE_CENSUS.people.every((person) => person.name.startsWith("DEV Member "))).toBe(
      true,
    );
  });

  it("independently recomputes canonical content and route digests", () => {
    const inputs = buildHomepageDigestInputs(projectRoot);
    const contentPayload = {
      DEV_CONTENT,
      assetManifest: inputs.assetManifest,
    };
    const routePayload = {
      DEV_ROUTE_CENSUS,
      assetManifest: inputs.assetManifest,
      routeContentProjectionManifest: inputs.routeContentProjectionManifest,
      routeSourceManifest: inputs.routeSourceManifest,
    };

    expect(implementationCanonicalJson(contentPayload)).toBe(
      independentCanonicalJson(contentPayload),
    );
    expect(implementationCanonicalJson(routePayload)).toBe(independentCanonicalJson(routePayload));
    expect(computeContentDigest(DEV_CONTENT, inputs.assetManifest)).toBe(
      independentDigest(contentPayload),
    );
    expect(computeRouteDigest(DEV_ROUTE_CENSUS, inputs)).toBe(independentDigest(routePayload));
    expect(computeContentDigest(DEV_CONTENT, inputs.assetManifest)).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(computeRouteDigest(DEV_ROUTE_CENSUS, inputs)).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(inputs.assetManifest.map((entry) => entry.path)).toEqual(
      [...inputs.assetManifest].map((entry) => entry.path).sort(),
    );
    expect(inputs.routeSourceManifest.map((entry) => entry.source)).toEqual(
      [...inputs.routeSourceManifest].map((entry) => entry.source).sort(),
    );
    expect(inputs.routeSourceManifest.map((entry) => entry.source)).toEqual(
      expect.arrayContaining([
        "src/api/assistenter.ts",
        "src/api/faq.ts",
        "src/routes/_home._index.tsx",
      ]),
    );
    for (const entry of inputs.routeSourceManifest) {
      expect(
        ROUTE_SOURCE_ROOTS.some(
          (sourceRoot) => entry.source === sourceRoot || entry.source.startsWith(`${sourceRoot}/`),
        ),
      ).toBe(true);
      expect(entry.byteLength).toBeGreaterThan(0);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const projectionByPath = new Map(
      inputs.routeContentProjectionManifest.map((projection) => [projection.path, projection]),
    );
    const expectedAssetPaths: Record<string, readonly string[]> = {
      "/": ["/images/teacher2.png", "/images/vektor-logo-circle.svg", "/images/vektor-logo.svg"],
      "/team": ["/images/teacher2.png", "/images/vektor-logo-circle.svg"],
      "/kontakt/trondheim": ["/images/vektor-logo-circle.svg"],
      "/team/aas/skolekoordinering": ["/images/teacher2.png"],
    };
    for (const [path, assetPaths] of Object.entries(expectedAssetPaths)) {
      const projection = projectionByPath.get(path);
      expect(projection).toBeDefined();
      expect(projection?.assetPaths).toEqual(assetPaths);
      expect(projection?.assets.map((entry) => `/${entry.path.replace(/^public\//, "")}`)).toEqual(
        assetPaths,
      );
    }

    for (const entry of inputs.assetManifest) {
      expect(entry.byteLength).toBeGreaterThan(0);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const projection of inputs.routeContentProjectionManifest) {
      expect(projection.path).toBeTruthy();
      expect(projection.assetPaths).toEqual([...projection.assetPaths].sort());
      for (const assetPath of projection.assetPaths) {
        expect(
          projection.assets.some(
            (asset) => `/${asset.path.replace(/^public\//, "")}` === assetPath,
          ),
        ).toBe(true);
      }
    }
  });
  it("changes route source evidence and digest for synthetic API bytes", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "homepage-route-source-"));
    try {
      for (const sourceRoot of ROUTE_SOURCE_ROOTS) {
        mkdirSync(join(temporaryRoot, sourceRoot), { recursive: true });
      }
      writeFileSync(
        join(temporaryRoot, "src/routes/synthetic-route.tsx"),
        "export const route = 'synthetic';\n",
        "utf8",
      );
      const apiSourcePath = join(temporaryRoot, "src/api/synthetic.ts");
      writeFileSync(apiSourcePath, "export const value = 'one';\n", "utf8");

      const baselineManifest = buildRouteSourceManifest(temporaryRoot);
      const baselineInputs = buildHomepageDigestInputs(projectRoot);
      const baselineDigest = computeRouteDigest(DEV_ROUTE_CENSUS, {
        ...baselineInputs,
        routeSourceManifest: baselineManifest,
      });

      writeFileSync(apiSourcePath, "export const value = 'two';\n", "utf8");
      const changedManifest = buildRouteSourceManifest(temporaryRoot);
      const changedDigest = computeRouteDigest(DEV_ROUTE_CENSUS, {
        ...baselineInputs,
        routeSourceManifest: changedManifest,
      });
      expect(changedManifest).not.toEqual(baselineManifest);
      expect(changedDigest).not.toBe(baselineDigest);

      writeFileSync(
        join(temporaryRoot, "src/api/synthetic-added.ts"),
        "export const added = true;\n",
        "utf8",
      );
      const addedManifest = buildRouteSourceManifest(temporaryRoot);
      const addedDigest = computeRouteDigest(DEV_ROUTE_CENSUS, {
        ...baselineInputs,
        routeSourceManifest: addedManifest,
      });
      expect(addedManifest.map((entry) => entry.source)).toContain("src/api/synthetic-added.ts");
      expect(addedDigest).not.toBe(changedDigest);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
