import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDirectory = fileURLToPath(new URL("..", import.meta.url));
const buildDirectory = join(dashboardDirectory, "build");
const forbiddenMarkers = [
  "preview-devtools-panel",
  "vektor-preview-devtools-panel",
  "preview-role-override",
  "vektor-preview-role-override",
  "Preview Devtools",
  "Foldkit DevTools",
];
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map"]);

const collectTextFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTextFiles(path);
    return textExtensions.has(extname(entry.name)) ? [path] : [];
  });

const build = (enabled) => {
  rmSync(buildDirectory, { recursive: true, force: true });
  const result = spawnSync("bun", ["run", "build"], {
    cwd: dashboardDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      VITE_PREVIEW_DEVTOOLS: enabled ? "true" : "false",
    },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`dashboard ${enabled ? "preview" : "production"} build failed`);
  }
};

const scan = () => {
  const findings = [];
  for (const path of collectTextFiles(buildDirectory)) {
    const text = readFileSync(path, "utf8");
    for (const marker of forbiddenMarkers) {
      if (path.includes(marker) || text.includes(marker)) findings.push({ marker, path });
    }
  }
  return findings;
};

try {
  build(false);
  const productionFindings = scan();
  if (productionFindings.length > 0) {
    throw new Error(
      `production bundle contains preview devtools:\n${productionFindings
        .map(({ marker, path }) => `- ${marker}: ${path}`)
        .join("\n")}`,
    );
  }
  process.stdout.write("preview bundle gate: production markers=0\n");

  build(true);
  const previewFindings = scan();
  for (const required of ["vektor-preview-devtools-panel", "vektor-preview-role-override"]) {
    if (!previewFindings.some(({ marker }) => marker === required)) {
      throw new Error(`preview positive control is missing ${required}`);
    }
  }
  process.stdout.write(`preview bundle gate: positive-control markers=${previewFindings.length}\n`);
} finally {
  rmSync(buildDirectory, { recursive: true, force: true });
}
