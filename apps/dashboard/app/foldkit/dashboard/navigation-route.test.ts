import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { profileLinks } from "./navigation";

const routeDirectory = dirname(
  fileURLToPath(new URL("../../routes/dashboard.tsx", import.meta.url)),
);
const dashboardRouteSource = readFileSync(join(routeDirectory, "dashboard.tsx"), "utf8");
const literalShellHrefs = [
  ...dashboardRouteSource.matchAll(/\bhref\(\s*["']([^"']+)["']\s*\)/gu),
].map(([, href]) => href);
const localShellHrefs = literalShellHrefs.filter((href) => href.startsWith("/"));
const localProfileHrefs = profileLinks
  .filter(({ external, href }) => external !== true && href.startsWith("/"))
  .map(({ href }) => href);
const navigationHrefs = new Set([...localShellHrefs, ...localProfileHrefs]);

const routeFileFor = (href: string): string => {
  const pathname = href.split(/[?#]/u, 1)[0] ?? href;
  const internalPath =
    pathname === "/dashboard" ? "/" : pathname.replace(/^\/dashboard(?=\/)/u, "");
  if (internalPath === "/") return "dashboard._index.tsx";
  const stem = internalPath.replace(/^\//u, "").replaceAll("/", ".");
  return `dashboard.${stem}._index.tsx`;
};

describe("dashboard navigation route integrity", () => {
  it("maps every literal local shell and profile href to an existing route module", () => {
    expect(literalShellHrefs.length).toBeGreaterThan(0);
    expect(localShellHrefs).toEqual(expect.arrayContaining(["/", "/profile", "/mine-utlegg"]));

    for (const href of navigationHrefs) {
      const routeFile = routeFileFor(href);
      expect(
        existsSync(join(routeDirectory, routeFile)),
        `${href} must be backed by app/routes/${routeFile}`,
      ).toBe(true);
    }
  });
});
