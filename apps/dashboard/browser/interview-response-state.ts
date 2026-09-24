/** Browser-realm callbacks serialized by Playwright. */
export const readDocumentCookie = (): string => document.cookie;

export const readBrowserStorage = () => ({
  local: Object.entries(localStorage),
  session: Object.entries(sessionStorage),
});
