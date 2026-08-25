/** Browser-realm callbacks serialized by Playwright. */
export const readDocumentCookie = (): string => document.cookie;

export const readBrowserStorage = (): {
  readonly local: readonly [string, string][];
  readonly session: readonly [string, string][];
} => ({
  local: Object.entries(localStorage),
  session: Object.entries(sessionStorage),
});
