import { schoolSurveyPath } from "../app/lib/school-survey-path";
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
 * React Router reserves a trailing `.data` for single-fetch requests. Preserve
 * an opaque survey ID with that suffix by redirecting browser documents to the
 * reversible route-safe representation shared with the loader.
 */
export const dashboardApplicationRequest = (request: Request): Request => {
  if (request.method !== "GET" && request.method !== "HEAD") return request;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/undersokelse/") || !url.pathname.endsWith(".data")) {
    return request;
  }
  const documentRequest =
    request.headers.get("sec-fetch-dest") === "document" ||
    request.headers.get("accept")?.includes("text/html") === true;
  if (!documentRequest) return request;

  const encodedSurveyId = url.pathname.slice("/undersokelse/".length);
  let surveyId: string;
  try {
    surveyId = decodeURIComponent(encodedSurveyId);
  } catch {
    return request;
  }
  url.pathname = schoolSurveyPath(surveyId);
  return new Request(url, request);
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
