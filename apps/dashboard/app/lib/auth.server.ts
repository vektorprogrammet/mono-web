import { redirect } from "react-router";

const AUTH_COOKIE = "jwt_token";

export function getToken(request: Request): string | null {
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${AUTH_COOKIE}=([^;]*)`));
  return match?.[1] ?? null;
}

export function createAuthHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

export function createAuthCookie(token: string): string {
  const secure =
    typeof process !== "undefined" && process.env.NODE_ENV === "production"
      ? "; Secure"
      : "";
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure}`;
}

export function createLogoutCookie(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function requireAuth(request: Request): string {
  const token = getToken(request);
  if (!token) throw redirect("/login");
  return token;
}
