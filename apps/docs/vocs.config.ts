import { defineConfig } from "vocs/config";

const repository = "https://github.com/vektorprogrammet/mono-web";

export default defineConfig({
  title: "Vektorprogrammet migration",
  description: "Source-linked guidance for the Vektorprogrammet legacy-to-native migration.",
  baseUrl: "https://vector-docs.phibkro.org",
  renderStrategy: "full-static",
  checkDeadlinks: true,
  head: {
    meta: {
      robots: "noindex, nofollow",
    },
  },
  search: {
    query: {
      boost: { title: 6, subtitle: 3, text: 2, category: 1, titles: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  },
  editLink: {
    link: `${repository}/edit/feat/0075-migration-docs/apps/docs/:path`,
    text: "Suggest a source change",
  },
  socials: [
    {
      icon: "github",
      link: repository,
    },
  ],
  topNav: [
    { text: "Tutorials", link: "/tutorials/orientation" },
    { text: "How-to", link: "/how-to/migrate-capability" },
    { text: "Reference", link: "/reference/migration-state" },
    { text: "Explanation", link: "/explanation/native-migration" },
  ],
  sidebar: [
    {
      text: "Start",
      items: [{ text: "Migration status", link: "/" }],
    },
    {
      text: "Tutorials",
      items: [
        { text: "First orientation", link: "/tutorials/orientation" },
        { text: "Trace a receipt", link: "/tutorials/receipt-journey" },
      ],
    },
    {
      text: "How-to guides",
      items: [
        { text: "Migrate a capability", link: "/how-to/migrate-capability" },
        { text: "Run the local stack", link: "/how-to/run-local-stack" },
        { text: "Run parity gates", link: "/how-to/run-parity-gates" },
        { text: "Update a design spec", link: "/how-to/update-design-spec" },
        {
          text: "Deploy or recover preview",
          link: "/how-to/deploy-recover-preview",
        },
      ],
    },
    {
      text: "Reference",
      items: [
        { text: "Migration state", link: "/reference/migration-state" },
        { text: "Runtime graph", link: "/reference/runtime-graph" },
        { text: "Effect runtime rules", link: "/reference/effect-runtime-rules" },
        { text: "Routes and API", link: "/reference/routes-and-api" },
        {
          text: "Specs and evidence",
          link: "/reference/design-spec-evidence-index",
        },
        { text: "Glossary", link: "/reference/glossary" },
      ],
    },
    {
      text: "Explanation",
      items: [
        { text: "Why migrate", link: "/explanation/native-migration" },
        {
          text: "Correctness and authority",
          link: "/explanation/correctness-and-authority",
        },
        { text: "Effect and Foldkit", link: "/explanation/effect-and-foldkit" },
        { text: "Evidence limits", link: "/explanation/evidence-limits" },
        {
          text: "Preview and production",
          link: "/explanation/preview-production-boundary",
        },
      ],
    },
  ],
});
