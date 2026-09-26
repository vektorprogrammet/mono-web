/**
 * The repository layout. `just layout` enforces this declaration against the tree, and
 * `just layout write` renders the layout table of README.md and AGENTS.md from it.
 * Change the layout here first; the check then names every file that disagrees.
 */

/** Top-level directories in table order. A package root holds one directory per app, package, or tool. */
export const topLevelDirectories = {
  apps: "Deployable applications",
  packages: "Layer-first libraries that the applications compose",
  tools: "Development, verification, and migration tools",
  infra: "Worker preview deployment configuration",
  docs: "Intended system, architecture, operations, and active specifications",
  patches: "Dependency patches that `patchedDependencies` in package.json applies",
  ".github": "Checks, Tests, Docs, and preview workflows and their actions",
  ".claude": "Claude Code settings and project rules",
} satisfies Readonly<Record<string, string>>;

/** Files at the root. Everything else lives in a top-level directory. */
export const rootFiles = {
  ".changelogrc.mjs": "Changelog generation from conventional commits",
  ".conventions-exceptions": "Recorded divergences from the shared conventions",
  ".editorconfig": "Editor defaults",
  ".gitignore": "Ignored files",
  ".oxfmtrc.json": "Formatter scope",
  "AGENTS.md": "Development practices",
  "CHANGELOG.md": "Change history generated from commits",
  "CLAUDE.md": "Link to AGENTS.md",
  "README.md": "Repository map and local commands",
  "STATE.md": "Current migration state",
  "bun.lock": "Resolved dependency versions",
  "devenv.lock": "Pinned devenv inputs",
  "devenv.nix": "Development shell, services, and Git hooks",
  "devenv.yaml": "devenv inputs",
  justfile: "Command surface",
  "oxlint.config.ts": "Lint policy",
  "package.json": "Workspaces, tool versions, and the dependency catalog",
  "secretspec.toml": "Declared secrets per profile and their Bitwarden Secrets Manager provider",
  "tsconfig.json": "Shared TypeScript options",
  "turbo.json": "Turbo task graph",
} satisfies Readonly<Record<string, string>>;

/** Directories that hold one directory per app, package, or tool. Each one is a workspace glob. */
export const packageRoots = ["apps", "packages", "tools"] as const;

/**
 * Every directory directly under a package root, in table order. A `package.json` may only sit
 * directly inside one of these.
 */
export const packageDirectories = {
  "apps/backend": "Native Effect HTTP process and workers",
  "apps/dashboard": "Authenticated React Router and Foldkit application",
  "apps/docs": "Documentation site that renders the repository documents",
  "apps/homepage": "Public React application",
  "packages/domain": "Business values, transitions, failures, and authority",
  "packages/database": "PostgreSQL schema, persistence, locks, audit, and outbox",
  "packages/http-api": "HTTP contracts, middleware declarations, and OpenAPI",
  "packages/sdk": "Generated native API client",
  "tools/acceptance": "Local API and browser acceptance probes of single journeys",
  "tools/conventions":
    "Layout, module guide, and construct catalogue checks and their generated files",
  "tools/e2e": "Golden journeys, local journey drivers, and legacy migration commands",
  "tools/oxlint": "Project Oxlint rules",
  "tools/placements-docs": "Placements API reference generation and checks",
  "tools/postgres": "Disposable PostgreSQL clusters of the selected major",
  "tools/scripts":
    "Local launcher, Git hook runner, job measurement, preview deployment, changelog",
  "tools/source-safety": "Staged-tree scan for credentials and personal data",
  "tools/verification": "Cross-application PostgreSQL proofs and migration rehearsals",
} satisfies Readonly<Record<string, string>>;

/** Where the bounded contexts of `docs/model/contexts.cml` are declared. */
export const contextMap = "docs/model/contexts.cml";

/** The folder for code that several contexts share. It may appear in every context layer. */
export const sharedKernel = "shared-kernel";

/**
 * A folder of a context layer that is not named after a bounded context. `context` names the CML
 * bounded context that owns the code under an older name; a folder without one is not a context.
 */
export interface FolderException {
  readonly context?: string;
  readonly reason: string;
}

const teamApplication = {
  context: "TeamApplications",
  reason: "Team applications under the singular folder name.",
} satisfies FolderException;

const onboarding = {
  context: "Recruitment",
  reason:
    "Onboarding invitation and account claim; decision D7 splits them between Recruitment and Identity.",
} satisfies FolderException;

/**
 * Layers whose direct folders are bounded contexts: each folder is the kebab-case name of a CML
 * bounded context, the shared kernel, or listed here with its reason. Remove an entry when its
 * folder moves to its context name; the check fails on an entry whose folder is gone.
 */
export const contextLayers = {
  "packages/domain/src": {
    "admission-period": {
      context: "Admissions",
      reason: "Admission periods, apart from applications.",
    },
    application: { context: "Admissions", reason: "Applications, apart from admission periods." },
    authz: {
      context: "AccessControl",
      reason: "The access-control interpreter under its older name.",
    },
    notification: { context: "Delivery", reason: "The mail notification port that Delivery owns." },
    onboarding,
    profile: { context: "People", reason: "Person profiles under their older name." },
    receipt: { context: "Economy", reason: "Expense claims under their older name." },
    "team-application": teamApplication,
    tutor: {
      reason:
        "The interview-conduct tracer: a fixture program and the D1 proof of its evidence format.",
    },
  },
  "packages/database/src": {
    "admission-period": { context: "Admissions", reason: "Admission period persistence." },
    application: { context: "Admissions", reason: "Application persistence and outbox." },
    authz: {
      context: "AccessControl",
      reason: "Authorization rule persistence under its older name.",
    },
    onboarding,
    profile: { context: "People", reason: "Profile persistence under its older name." },
    receipt: { context: "Economy", reason: "Expense claim persistence under its older name." },
    "team-application": teamApplication,
    "test-support": {
      reason: "Disposable PostgreSQL fixtures and statement observers for tests and proofs.",
    },
  },
  "apps/backend/src": {
    admission: {
      context: "Admissions",
      reason: "HTTP handlers of admission periods and applications.",
    },
    application: { context: "Admissions", reason: "Application effects and their worker." },
    directory: { context: "People", reason: "The people directory read." },
    "http-api": {
      reason:
        "Transport shared by every context: problems, rate limits, JSON reading, receipt transactions.",
    },
    mail: { context: "Delivery", reason: "Mail provider adapters behind the Delivery mail port." },
    onboarding,
    "password-recovery": { context: "Identity", reason: "The password recovery worker." },
    profile: { context: "People", reason: "Profile HTTP handlers under their older name." },
    receipt: { context: "Economy", reason: "Expense claim HTTP handlers and private files." },
    "team-application": teamApplication,
    test: { reason: "Native HTTP composition for backend tests." },
  },
  "apps/dashboard/app/foldkit": {
    dashboard: { reason: "The application shell: navigation and the routes to each context page." },
    "dated-school-service": { context: "Placements", reason: "Dated school-service commitments." },
    interview: { context: "Recruitment", reason: "Interview conduct." },
    profile: { context: "People", reason: "Profile self-service under its older name." },
    "recruitment-maintenance": {
      context: "Recruitment",
      reason: "Questionnaire and interview staffing maintenance.",
    },
    scheduling: { context: "Recruitment", reason: "Interview scheduling." },
  },
} satisfies Readonly<Record<string, Readonly<Record<string, FolderException>>>>;

/**
 * What each context layer holds. The module guide of every folder in a layer states it.
 */
export const contextLayerRoles = {
  "packages/domain/src":
    "The domain layer holds business values, state transitions, failures, capability requirements, and service contracts. It imports no database, HTTP, application, browser, provider, or migration-tool code.",
  "packages/database/src":
    "The persistence layer holds PostgreSQL adapters and service Layers. They keep state, revision, command receipts, audit, and outbox writes in the caller's transaction, and own SQL projections, joins, ordering, scope, and storage codecs.",
  "apps/backend/src":
    "The backend layer holds HTTP handlers, delivery workers, and provider adapters that the native process composes. It keeps response receipts and preconditions in the transport, and provider I/O after commit.",
  "apps/dashboard/app/foldkit":
    "The dashboard layer holds authenticated journeys: one Foldkit Model per workflow renders server-owned facts and submits commands through the generated SDK.",
} satisfies Readonly<Record<keyof typeof contextLayers, string>>;

/**
 * Apps and packages never import tools. Each exception names the tool, the importing directories,
 * and why. The check fails on an exception that no import uses.
 */
export interface ToolImportException {
  readonly tool: string;
  readonly importers: ReadonlyArray<string>;
  readonly reason: string;
}

export const toolImportExceptions = [
  {
    tool: "tools/postgres",
    importers: [
      "apps/backend/test/",
      "apps/dashboard/e2e/",
      "apps/homepage/e2e/",
      "packages/database/runtime/",
    ],
    reason:
      "Test harnesses, browser evidence drivers, and PostgreSQL proofs start disposable clusters of the selected major through the one toolchain and reserve their loopback ports through it.",
  },
  {
    tool: "tools/e2e",
    importers: ["apps/dashboard/e2e/", "apps/homepage/e2e/"],
    reason:
      "Browser evidence drivers share the golden harness: the local backend environment, evidence digests, and the delivery sink.",
  },
] satisfies ReadonlyArray<ToolImportException>;

/** Root `package.json` scripts: only what Bun, Turbo, and tools run. People run `just` recipes. */
export const rootScripts = {
  prepare:
    "Bun runs it after install to patch TypeScript and Oxlint with the Effect language service.",
} satisfies Readonly<Record<string, string>>;
