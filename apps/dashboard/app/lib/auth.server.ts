import { UnauthenticatedActorError, UnauthorizedError } from "@vektorprogrammet/sdk";
import { redirect } from "react-router";
import { createAuthenticatedClient, serverApiEndpoint } from "./api.server";

const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

type SessionInspection =
  | { readonly _tag: "Authenticated"; readonly cookie: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Invalid" };

export type SignInResult =
  | { readonly _tag: "Authenticated"; readonly headers: Headers }
  | { readonly _tag: "InvalidCredentials" }
  | { readonly _tag: "RateLimited" }
  | { readonly _tag: "Unavailable" };

function backendRequestHeaders(request: Request, includeCookie: boolean): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Origin: request.headers.get("Origin") ?? new URL(request.url).origin,
  });
  const cookie = request.headers.get("Cookie");
  if (includeCookie && cookie !== null) headers.set("Cookie", cookie);
  return headers;
}

function hasSessionCookie(cookie: string): boolean {
  return cookie.split(";").some((pair) => {
    const separator = pair.indexOf("=");
    if (separator < 1 || separator === pair.length - 1) return false;
    const name = pair.slice(0, separator).trim();
    return SESSION_COOKIE_NAMES.some((candidate) => candidate === name);
  });
}

async function inspectSession(request: Request): Promise<SessionInspection> {
  const cookie = request.headers.get("Cookie");
  if (cookie === null || !hasSessionCookie(cookie)) return { _tag: "Missing" };

  try {
    await createAuthenticatedClient(cookie).me.session();
    return { _tag: "Authenticated", cookie };
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof UnauthenticatedActorError) {
      return { _tag: "Invalid" };
    }
    throw error;
  }
}

export function forwardSetCookieHeaders(source: Headers): Headers {
  const target = new Headers();
  for (const value of source.getSetCookie()) target.append("Set-Cookie", value);
  return target;
}

export async function signInWithEmail(
  request: Request,
  email: string,
  password: string,
): Promise<SignInResult> {
  const headers = backendRequestHeaders(request, false);
  headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(serverApiEndpoint("/api/auth/sign-in/email"), {
      method: "POST",
      headers,
      body: JSON.stringify({ email, password }),
      signal: request.signal,
      redirect: "manual",
    });
  } catch {
    return { _tag: "Unavailable" };
  }

  if (response.status === 429) return { _tag: "RateLimited" };
  if (!response.ok) return { _tag: "InvalidCredentials" };

  const responseHeaders = forwardSetCookieHeaders(response.headers);
  const sessionIssued = responseHeaders
    .getSetCookie()
    .some((value) => SESSION_COOKIE_NAMES.some((name) => value.startsWith(`${name}=`)));
  return sessionIssued
    ? { _tag: "Authenticated", headers: responseHeaders }
    : { _tag: "Unavailable" };
}

export async function signOut(request: Request): Promise<Headers> {
  const response = await fetch(serverApiEndpoint("/api/auth/sign-out"), {
    method: "POST",
    headers: backendRequestHeaders(request, true),
    signal: request.signal,
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Response("Sign out failed", { status: 502 });
  }
  return forwardSetCookieHeaders(response.headers);
}

export async function expiredSessionRedirect(request: Request): Promise<Response> {
  const headers = await signOut(request).catch(() => new Headers());
  return redirect("/login?expired=true", { headers });
}

export async function hasAuthenticatedSession(request: Request): Promise<boolean> {
  return (await inspectSession(request))._tag === "Authenticated";
}

export async function requireAuth(request: Request): Promise<string> {
  const session = await inspectSession(request);
  if (session._tag === "Authenticated") return session.cookie;
  if (session._tag === "Missing") throw redirect("/login");
  throw await expiredSessionRedirect(request);
}

export function safeRedirect(
  destination: FormDataEntryValue | null,
  fallback = "/dashboard",
): string {
  if (
    typeof destination !== "string" ||
    !destination.startsWith("/") ||
    destination.startsWith("//")
  ) {
    return fallback;
  }
  try {
    const base = new URL("http://dashboard.invalid");
    const target = new URL(destination, base);
    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}
