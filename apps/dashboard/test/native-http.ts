import { makeNativeProblem, type NativeProblemCode } from "@vektorprogrammet/http-api";
import { RouterContextProvider } from "react-router";

export const sessionCookie = "better-auth.session_token=session-value";

export const privateReadHeaders = { "cache-control": "private, no-store", vary: "Origin" };

export const conditionalReadHeaders = {
  "cache-control": "private, no-store",
  vary: "Origin",
  etag: '"vkr2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
};

export const nativeSessionResponse = () => Response.json({
  sessionId: "session-1",
  personId: "person-1",
  createdAt: "2030-01-01T00:00:00Z",
  updatedAt: "2030-01-01T00:00:00Z",
  expiresAt: "2030-01-02T00:00:00Z",
  ipAddress: null,
  userAgent: null,
  current: true,
}, { headers: privateReadHeaders });

export const routeArgs = <Params extends Record<string, string>>(request: Request, params: Params) => ({
  request,
  params,
  url: new URL(request.url),
  pattern: new URL(request.url).pathname,
  context: new RouterContextProvider(),
});

export const nativeProblemResponse = (code: NativeProblemCode) => {
  const problem = makeNativeProblem(code);
  const headers = new Headers({ "content-type": "application/problem+json", "cache-control": "no-store", vary: "Origin" });

  if (problem.status === 401) headers.set("www-authenticate", 'VektorSession realm="native-api"');

  return Response.json(problem, { status: problem.status, headers });
};

