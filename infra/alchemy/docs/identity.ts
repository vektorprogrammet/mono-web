export const DOCS_IDENTITY = {
  stack: "vektor-docs",
  stage: "docs-dev-main",
  profile: "goal1-staging",
  logicalId: "MigrationDocs",
  workerName: "vektor-migration-docs",
  hostname: "vektor-docs.phibkro.org",
  stateNamespace: ".alchemy/state/vektor-docs/docs-dev-main",
  forbiddenHostnames: ["vektor.phibkro.org", "api.vektor.phibkro.org", "vektorprogrammet.no"],
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
