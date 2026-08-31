import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";

const StatusSchema = z.enum([
  "legacy-authority",
  "native-implemented",
  "native-observed",
  "parity-observed",
  "cutover-accepted",
  "production-cutover",
  "drifted",
  "stale",
  "unsupported",
]);

const StateRowSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  capability: z.string().min(1),
  journey: z.string().min(1),
  productionAuthority: z.string().min(1),
  statuses: z.array(StatusSchema).min(1),
  scope: z.string().min(1),
  sourceRefs: z.array(z.string().min(1)).min(1),
  designSpecRefs: z.array(z.string().min(1)),
  evidenceRefs: z.array(z.string().min(1)),
});

const MigrationStateSchema = z.strictObject({
  $schema: z.literal("https://vektor-docs.phibkro.org/migration-state.schema.json"),
  recordType: z.literal("vektor.migration-state/v1"),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  inspectedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  stateDocument: z.strictObject({
    path: z.literal("STATE.md"),
    present: z.literal(false),
    status: z.literal("unsupported"),
    note: z.string().min(1),
  }),
  rows: z
    .array(StateRowSchema)
    .min(1)
    .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length, {
      message: "row ids must be unique",
    }),
});

type MigrationState = z.infer<typeof MigrationStateSchema>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const docsRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(docsRoot, "../..");
const statePath = join(docsRoot, "data/migration-state.json");
const publicSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://vektor-docs.phibkro.org/migration-state.schema.json",
  ...z.toJSONSchema(MigrationStateSchema),
};
const pagesDirectory = join(docsRoot, "src/pages/reference");
const publicDirectory = join(docsRoot, "public");
const repositoryUrl = "https://github.com/vektorprogrammet/mono-web";

const repositoryPath = (reference: string): string => reference.split("#", 1)[0] ?? reference;
const referenceLabel = (reference: string): string => {
  const [path, symbol] = reference.split("#", 2);
  return symbol === undefined ? `\`${path}\`` : `\`${path}\` — \`${symbol}\``;
};
const fileLink = (revision: string, reference: string): string => {
  const path = repositoryPath(reference);
  return `[${referenceLabel(reference)}](${repositoryUrl}/blob/${revision}/${path})`;
};
const treeLink = (revision: string, path: string): string =>
  `[\`${path}\`](${repositoryUrl}/tree/${revision}/${path})`;

const makeSureReferencesExist = async (state: MigrationState): Promise<void> => {
  const references = state.rows.flatMap((row) => [
    ...row.sourceRefs,
    ...row.designSpecRefs,
    ...row.evidenceRefs,
  ]);
  const failures: string[] = [];
  await Promise.all(
    references.map(async (reference) => {
      try {
        await stat(join(repositoryRoot, repositoryPath(reference)));
      } catch {
        failures.push(reference);
      }
    }),
  );
  if (failures.length > 0) {
    failures.sort();
    throw new Error(`migration state has missing references:\n${failures.join("\n")}`);
  }
  try {
    await stat(join(repositoryRoot, state.stateDocument.path));
    throw new Error("STATE.md now exists; update the canonical migration state before build");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("STATE.md now exists")) throw error;
  }
};

const migrationStatePage = (state: MigrationState): string => {
  const rows = state.rows
    .map(
      (row) =>
        `## ${row.capability}\n\n**Journey:** ${row.journey}\n\n**Current production authority:** ${row.productionAuthority}\n\n**Warranted statuses:** ${row.statuses.map((status) => `\`${status}\``).join(", ")}\n\n${row.scope}\n\n### Sources\n\n${row.sourceRefs.map((reference) => `- ${fileLink(state.sourceRevision, reference)}`).join("\n")}\n\n### Design specs\n\n${row.designSpecRefs.length === 0 ? "No design spec reference is recorded." : row.designSpecRefs.map((reference) => `- ${fileLink(state.sourceRevision, reference)}`).join("\n")}\n\n### Evidence\n\n${row.evidenceRefs.length === 0 ? "No checked-in evidence artifact supports a stronger runtime claim." : row.evidenceRefs.map((reference) => `- ${fileLink(state.sourceRevision, reference)}`).join("\n")}`,
    )
    .join("\n\n");
  return `---\ntitle: Migration state\ndescription: Source-linked capability and journey state at the frozen revision.\n---\n\n# Migration state\n\nThis page comes from the canonical JSON artifact at \`/migration-state.json\`. The build fails when a referenced source or evidence path is missing.\n\n**Inspected revision:** \`${state.sourceRevision}\`  \n**Inspection date:** ${state.inspectedOn}\n\n:::warning\n${state.stateDocument.note}\n:::\n\nThe statuses separate source, runtime, parity, and cutover claims. Read [Evidence limits](/explanation/evidence-limits) before you use a row as a gate.\n\n${rows}\n`;
};

type SpecIndexRow = {
  readonly path: string;
  readonly title: string;
  readonly recordedStatus: string;
  readonly classification: string;
};

const recordedStatus = (content: string): string => {
  const table = content.match(/^\|\s*(?:Status|State)\s*\|\s*([^|]+?)\s*\|\s*$/imu)?.[1];
  const prose = content.match(/^>??\s*\*\*(?:Status|State):\*\*\s*(.+)$/imu)?.[1];
  return (table ?? prose ?? "No explicit status metadata").trim();
};

const classifySpec = (status: string): string => {
  const value = status.toLowerCase();
  if (value.includes("superseded") || value.includes("stale")) return "stale";
  if (value.includes("drift")) return "drifted";
  if (value.includes("accepted") || value.includes("passed")) return "accepted-with-limits";
  if (value.includes("frozen")) return "frozen";
  if (value.includes("draft")) return "draft";
  return "unclassified";
};

const readSpecIndex = async (): Promise<ReadonlyArray<SpecIndexRow>> => {
  const specDirectory = join(repositoryRoot, "design-specs");
  const files = (await readdir(specDirectory))
    .filter((name) => name.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  return Promise.all(
    files.map(async (name) => {
      const path = `design-specs/${name}`;
      const content = await readFile(join(repositoryRoot, path), "utf8");
      const title = content.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? name;
      const status = recordedStatus(content);
      return {
        path,
        title,
        recordedStatus: status,
        classification: classifySpec(status),
      };
    }),
  );
};

const countFiles = async (directory: string): Promise<number> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const counts = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory() ? countFiles(join(directory, entry.name)) : Promise.resolve(1),
    ),
  );
  return counts.reduce((total, count) => total + count, 0);
};

const evidenceClassification = (name: string): string => {
  if (name.startsWith("0069-apex-preview")) return "preview-observation";
  if (name === "functional-parity") return "scoped-parity-inventory";
  if (name === "security-h3") return "scoped-security-evidence";
  return "unclassified-evidence";
};

const designSpecEvidencePage = async (state: MigrationState): Promise<string> => {
  const specs = await readSpecIndex();
  const specRows = specs
    .map(
      (spec) =>
        `| [${spec.title}](${repositoryUrl}/blob/${state.sourceRevision}/${spec.path}) | ${spec.classification} | ${spec.recordedStatus.replaceAll("|", "\\|")} |`,
    )
    .join("\n");
  const evidenceDirectory = join(repositoryRoot, "evidence");
  const evidenceEntries = (await readdir(evidenceDirectory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name, "en", { numeric: true }),
  );
  const evidenceRows = await Promise.all(
    evidenceEntries.map(async (entry) => {
      const path = `evidence/${entry.name}`;
      const files = entry.isDirectory() ? await countFiles(join(evidenceDirectory, entry.name)) : 1;
      const link = entry.isDirectory()
        ? treeLink(state.sourceRevision, path)
        : fileLink(state.sourceRevision, path);
      return `| ${link} | ${evidenceClassification(entry.name)} | ${files} |`;
    }),
  );
  return `---\ntitle: Design-spec and evidence index\ndescription: Generated classifications for migration decisions and evidence bundles.\n---\n\n# Design-spec and evidence index\n\nThis page is generated from repository paths at \`${state.sourceRevision}\`. The generator reads explicit status metadata. It does not infer acceptance from a filename.\n\n\`accepted-with-limits\` means that the recorded status names acceptance or passed evidence. The original scope still applies.\n\n\`drifted\` and \`stale\` appear only when explicit status metadata uses those terms. \`unclassified\` means that automation cannot make the decision.\n\n## Design specs\n\n| Design spec | Classification | Recorded status |\n| --- | --- | --- |\n${specRows}\n\n## Evidence bundles\n\n| Evidence path | Classification | Files |\n| --- | --- | ---: |\n${evidenceRows.join("\n")}\n\nA test result is an observation over its checked scope. It is not proof of full parity or production readiness.\n`;
};

const main = async (): Promise<void> => {
  const state = MigrationStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  await makeSureReferencesExist(state);
  await mkdir(pagesDirectory, { recursive: true });
  await mkdir(publicDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(pagesDirectory, "migration-state.mdx"), migrationStatePage(state)),
    writeFile(
      join(pagesDirectory, "design-spec-evidence-index.mdx"),
      await designSpecEvidencePage(state),
    ),
    writeFile(join(publicDirectory, "migration-state.json"), `${JSON.stringify(state, null, 2)}\n`),
    writeFile(
      join(publicDirectory, "migration-state.schema.json"),
      `${JSON.stringify(publicSchema, null, 2)}\n`,
    ),
  ]);
  const outputs = [
    join(pagesDirectory, "migration-state.mdx"),
    join(pagesDirectory, "design-spec-evidence-index.mdx"),
    join(publicDirectory, "migration-state.json"),
    join(publicDirectory, "migration-state.schema.json"),
  ].map((path) => relative(repositoryRoot, path).split(sep).join("/"));
  process.stdout.write(`generated ${outputs.join(", ")}\n`);
};

await main();
