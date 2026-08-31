import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appDirectory = fileURLToPath(new URL("..", import.meta.url));

const collectServerModules = (directory: string): Array<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectServerModules(path);
    return /\.server\.tsx?$/.test(entry.name) ? [path] : [];
  });

describe("preview devtools server authority boundary", () => {
  it("keeps role override storage out of every server module", () => {
    const violations = collectServerModules(appDirectory).filter((path) => {
      const source = readFileSync(path, "utf8");
      return (
        source.includes("vektor-preview-role-override") ||
        source.includes("preview-role-override") ||
        source.includes("preview-devtools-panel")
      );
    });

    expect(violations).toEqual([]);
  });
});
