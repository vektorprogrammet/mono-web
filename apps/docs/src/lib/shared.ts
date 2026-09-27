import { createGetUrl } from "fumadocs-core/source";

export const appName = "Vektorprogrammet";

export const docsRoute = "/docs";

export const gitConfig = {
  user: "vektorprogrammet",
  repo: "mono-web",
  branch: "main",
};

/**
 * The route of the page with these slugs: the start page, which includes the README, at the root
 * of the site, and every other page below `/docs`.
 */
export const urlOf = (slugs: ReadonlyArray<string>): string =>
  slugs.length === 0 ? "/" : `${docsRoute}/${slugs.join("/")}`;

const getDocsUrl = createGetUrl(docsRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs];

  if (segments.length === 0) {
    segments.push("index.md");
  } else {
    segments[segments.length - 1] += ".md";
  }

  return { segments, url: getDocsUrl(segments, page.locale) };
}

/** @returns page slugs */
export function decodeMarkdownUrl(segments: string[]) {
  if (segments.length === 0) return [];

  const out = [...segments];
  out[out.length - 1] = out[out.length - 1].replace(/\.md$/, "");

  if (out.length === 1 && out[0] === "index") out.pop();

  return out;
}
