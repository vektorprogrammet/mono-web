/** Browser-realm callback serialized by Playwright. */
export const countServiceWorkerRegistrations = async (): Promise<number> =>
  navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0;
