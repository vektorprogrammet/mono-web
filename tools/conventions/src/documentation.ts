/**
 * The extracts of the code that the documentation site renders into its pages. `apps/docs` is the
 * only producer of documentation: its site and `just docs generate` call these functions, so the
 * page on the site, its Markdown in `docs/`, and the check of that Markdown read one source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { constructPages, readConstructs, renderPages } from "./constructs.js";
import { readRepository } from "./repository.js";
import { readWorkflow, testsWorkflow } from "./journeys.js";
import { readJustfile } from "./justfile.js";
import { hostedJourneys } from "./sections.js";

/** An extract: the Markdown that a page shows in place of its element, from the repository at `root`. */
export type Extract = (root: string) => string;

/**
 * The extracts by the name of the element that places each one in a page, such as
 * `<HostedJourneys />` in the testing page.
 */
export const extracts = {
  HostedJourneys: (root) =>
    hostedJourneys(
      readJustfile(join(root, "justfile")),
      readWorkflow(readFileSync(join(root, testsWorkflow), "utf8")),
    ),
} satisfies Readonly<Record<string, Extract>>;

export { constructPages };

/** Construct documents derived from tagged declarations; apps/docs owns their file writes. */
export const constructDocuments = (root: string, staged = false): ReadonlyMap<string, string> =>
  renderPages(readConstructs(readRepository(root, staged)).constructs);
