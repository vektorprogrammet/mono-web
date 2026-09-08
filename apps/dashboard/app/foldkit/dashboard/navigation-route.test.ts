import { visibleShellNavigationLinks } from "./shell";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { profileLinks, controlPanelLink, navigationSections } from "./navigation";

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
const localFoldkitHrefs = [
  controlPanelLink,
  ...navigationSections.flatMap((section) =>
    section.entries.flatMap((entry) => (entry.kind === "link" ? [entry.link] : entry.links)),
  ),
]
  .filter((link) => !link.external && link.href.startsWith("/"))
  .map((link) => link.href);
const navigationHrefs = new Set([...localShellHrefs, ...localProfileHrefs, ...localFoldkitHrefs]);

const routeFilesFor = (href: string): string[] => {
  const pathname = href.split(/[?#]/u, 1)[0] ?? href;
  const internalPath =
    pathname === "/dashboard" ? "/" : pathname.replace(/^\/dashboard(?=\/)/u, "");
  if (internalPath === "/") return ["dashboard._index.tsx"];
  const stem = internalPath.replace(/^\//u, "").replaceAll("/", ".");
  return [`dashboard.${stem}._index.tsx`, `dashboard.${stem}.tsx`];
};

describe("dashboard navigation route integrity", () => {
  it("maps every literal local shell and profile href to an existing route module", () => {
    expect(literalShellHrefs.length).toBeGreaterThan(0);
    expect(localShellHrefs).toEqual(expect.arrayContaining(["/", "/profile", "/mine-utlegg"]));

    for (const href of navigationHrefs) {
      const routeFiles = routeFilesFor(href);
      expect(
        routeFiles.some((routeFile) => existsSync(join(routeDirectory, routeFile))),
        `${href} must be backed by an index or leaf route module`,
      ).toBe(true);
    }
  });
});

it("keeps coordinator report navigation out of the ordinary member shell", () => {
  const ordinary = { title: "Intervjuer", url: "/dashboard/intervjuer" };
  const report = {
    title: "Fullførte intervjuer",
    url: "/dashboard/intervjuer/rapport",
    coordinatorOnly: true,
  };
  expect(visibleShellNavigationLinks([ordinary, report], false)).toEqual([ordinary]);
  expect(visibleShellNavigationLinks([ordinary, report], true)).toEqual([ordinary, report]);
  expect(dashboardRouteSource).toMatch(
    /title: "Fullførte intervjuer",\s*url: href\("\/intervjuer\/rapport"\),\s*coordinatorOnly: true/,
  );
});
