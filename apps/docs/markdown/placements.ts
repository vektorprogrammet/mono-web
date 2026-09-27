import { markerOf } from "./render";

export const placementsReadPath = "docs/packages/domain/placements-api.md";

export const placementsStaticPath = "packages/domain/api";

/** The site publishes TypeDoc HTML; this Markdown read path links the same reference. */
export const placementsReference = (): string =>
  [
    markerOf("packages/domain/package.json"),
    "",
    "# Placements API reference",
    "",
    "The public Placements exports of the domain and database packages define this TypeDoc reference.",
    "",
    "[Browse the generated API reference](https://vektorprogrammet.github.io/mono-web/packages/domain/api/)",
    "",
  ].join("\n");
