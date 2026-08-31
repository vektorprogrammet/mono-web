import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { profileLinks } from "./navigation";

const routeDirectory = dirname(
  fileURLToPath(new URL("../../routes/dashboard.tsx", import.meta.url)),
);
const dashboardRouteSource = readFileSync(join(routeDirectory, "dashboard.tsx"), "utf8");
const navigationStart = dashboardRouteSource.indexOf("const mainLinks = [");
const navigationEnd = dashboardRouteSource.indexOf("function NavLinks(", navigationStart);
const shellNavigationSource = dashboardRouteSource.slice(navigationStart, navigationEnd);

const shellHrefs = [...shellNavigationSource.matchAll(/href\("([^"]+)"\)/gu)].map(
  ([, href]) => href,
);
const navigationHrefs = new Set([...shellHrefs, ...profileLinks.map(({ href }) => href)]);

const routeFileFor = (href: string): string => {
  const pathname = href.split("?", 1)[0] ?? href;
  if (pathname === "/dashboard") return "dashboard._index.tsx";
  const stem = pathname.replace(/^\//u, "").replaceAll("/", ".");
  return `${stem}._index.tsx`;
};

describe("dashboard navigation route integrity", () => {
  it("maps every main, admin, and profile href to an existing route module", () => {
    expect(navigationStart).toBeGreaterThanOrEqual(0);
    expect(navigationEnd).toBeGreaterThan(navigationStart);
    expect(shellHrefs.length).toBeGreaterThan(0);

    for (const href of navigationHrefs) {
      const routeFile = routeFileFor(href);
      expect(
        existsSync(join(routeDirectory, routeFile)),
        `${href} must be backed by app/routes/${routeFile}`,
      ).toBe(true);
    }
  });
});
