export const DOCS_IDENTITY = {
  stack: "vector-docs",
  stage: "docs-dev-main",
  profile: "goal1-staging",
  logicalId: "VectorMigrationDocs",
  workerName: "vector-migration-docs",
  hostname: "vector-docs.phibkro.org",
  stateNamespace: ".alchemy/state/vector-docs/docs-dev-main",
  forbiddenHostnames: [
    "vektor-docs.phibkro.org",
    "vektor.phibkro.org",
    "api.vektor.phibkro.org",
    "vektorprogrammet.no",
  ],
} as const;

export const assertDocsDeploymentIdentity = (input: {
  readonly stage: string;
  readonly profile: string;
}): void => {
  if (input.stage !== DOCS_IDENTITY.stage) {
    throw new Error(`docs deployment accepts only stage ${DOCS_IDENTITY.stage}`);
  }
  if (input.profile !== DOCS_IDENTITY.profile) {
    throw new Error(`docs deployment accepts only profile ${DOCS_IDENTITY.profile}`);
  }
  if (DOCS_IDENTITY.forbiddenHostnames.some((hostname: string) => hostname === DOCS_IDENTITY.hostname)) {
    throw new Error("docs hostname overlaps a forbidden application hostname");
  }
};
