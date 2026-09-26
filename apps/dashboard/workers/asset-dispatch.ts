export interface DashboardAssetBinding {
  fetch(request: Request): Promise<Response>;
}

const isStaticAssetPath = (pathname: string): boolean => {
  const last = pathname.split("/").at(-1);

  return (
    pathname.startsWith("/assets/") || (last?.includes(".") === true && !pathname.endsWith(".data"))
  );
};

/**
 * Resolves a dashboard asset candidate. A dotted application route falls
 * through when the asset binding has no matching file; fingerprinted build
 * assets remain authoritative 404s instead of entering React Router.
 */
export const dashboardAssetResponse = async (
  request: Request,
  assets: DashboardAssetBinding,
): Promise<Response | undefined> => {
  const pathname = new URL(request.url).pathname;

  if (!isStaticAssetPath(pathname)) return undefined;

  const response = await assets.fetch(request);

  return response.status !== 404 || pathname.startsWith("/assets/") ? response : undefined;
};
