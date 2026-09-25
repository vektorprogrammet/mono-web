import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEV_CONTENT, DEV_CONTENT_SOURCE, DEV_ROUTE_CENSUS } from "../src/lib/dev-content";
import {
  ROUTE_SOURCE_ROOTS,
  buildHomepageDigestInputs,
  buildRouteSourceManifest,
  canonicalJson as implementationCanonicalJson,
  computeContentDigest,
  computeRouteDigest,
} from "../vite-digests";



const projectRoot = fileURLToPath(new URL("..", import.meta.url));





describe("DEV CONTENT contract", () => {
  it("keeps one typed, local, synthetic content source", () => {
    expect(DEV_CONTENT_SOURCE).toBe("dev-content");
    expect(DEV_CONTENT.sponsors.length).toBeGreaterThan(0);
    expect(DEV_CONTENT.departments.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(DEV_CONTENT);
    expect(serialized).not.toMatch(/vektorprogrammet\.no|railway|api[_-]?url/i);

    for (const sponsor of DEV_CONTENT.sponsors) {
      expect(sponsor.image).toMatch(/^\//);
      expect(sponsor.href).toMatch(/^https:\/\/example\.invalid\//);
    }

    for (const department of DEV_CONTENT.departments) {
      expect(department.image).toMatch(/^\//);
      expect(department.email).toMatch(/@example\.invalid$/);
      expect(
        department.contacts.every((contact) => contact.mail.endsWith("@example.invalid")),
      ).toBe(true);
    }
  });

  it("derives a complete deterministic route census", () => {
    expect(new Set(DEV_ROUTE_CENSUS.paths).size).toBe(DEV_ROUTE_CENSUS.paths.length);
    expect(DEV_ROUTE_CENSUS.paths).toContain("/");
    expect(DEV_ROUTE_CENSUS.paths).toContain("/team");
    expect(DEV_ROUTE_CENSUS.paths).toContain("/kontakt/trondheim");
    expect(DEV_ROUTE_CENSUS.paths.filter((path) => path.startsWith("/team"))).toEqual([
      "/team",
      "/team/:department",
      "/team/:teamId/soknad",
    ]);
    expect(DEV_ROUTE_CENSUS.departments.map(({ id }) => id)).toEqual([
      "aas",
      "bergen",
      "hovedstyret",
      "trondheim",
    ]);
    expect(DEV_ROUTE_CENSUS.paths).toEqual([...DEV_ROUTE_CENSUS.paths].sort());

    for (const department of DEV_CONTENT.departments) {
      expect(DEV_ROUTE_CENSUS.paths).toContain(`/kontakt/${department.id}`);
      expect(DEV_ROUTE_CENSUS.departments).toContainEqual({
        id: department.id,
        path: `/kontakt/${department.id}`,
        memberCount: department.members,
        contacts: department.contacts,
      });
    }
  });

  it("independently recomputes canonical content and route digests", () => {
    const inputs = buildHomepageDigestInputs(projectRoot);

    expect(implementationCanonicalJson({ "2": "two", "10": "ten", z: undefined, a: [3, { y: null, x: true }] })).toBe('{"10":"ten","2":"two","a":[3,{"x":true,"y":null}]}');
    const contentBytes = '{"DEV_CONTENT":{"departments":[],"sponsors":[],"statistics":{"assistantCount":0,"teamMemberCount":0}},"assetManifest":[]}\n';
    expect(computeContentDigest({ departments: [], sponsors: [], statistics: { assistantCount: 0, teamMemberCount: 0 } }, [])).toBe(
      `sha256:${createHash("sha256").update(contentBytes).digest("hex")}`,
    );
    const routeBytes = '{"DEV_ROUTE_CENSUS":{"departments":[],"paths":[]},"assetManifest":[],"routeContentProjectionManifest":[],"routeSourceManifest":[]}\n';
    expect(computeRouteDigest({ departments: [], paths: [] }, { assetManifest: [], routeContentProjectionManifest: [], routeSourceManifest: [] })).toBe(
      `sha256:${createHash("sha256").update(routeBytes).digest("hex")}`,
    );


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

    const expectedAssetPaths = {
      "/": ["/images/vektor-logo-circle.svg", "/images/vektor-logo.svg"],
      "/team": [],
      "/team/:department": [],
      "/team/:teamId/soknad": [],
      "/kontakt/trondheim": ["/images/vektor-logo-circle.svg"],
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
