import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import {
  Form,
  Link,
  data,
  redirect,
  useActionData,
  useLoaderData,
  useSearchParams,
} from "react-router";
import { hasAuthenticatedSession, safeRedirect, signInWithEmail } from "../lib/auth.server";
import {
  guardOAuthContinuation,
  hasTrustedActionOrigin,
  inspectPendingOAuthRequest,
  oauthNoStoreHeaders,
  sessionCookieFromResponse,
} from "../lib/oauth.server";
import type { Route } from "./+types/login";

export async function loader({ request }: Route.LoaderArgs) {
  const oauth = inspectPendingOAuthRequest(request);
  if (oauth._tag === "Invalid") {
    return data({ oauthError: true, oauth: true }, { status: 400, headers: oauthNoStoreHeaders() });
  }
  if (await hasAuthenticatedSession(request)) {
    throw redirect("/", oauth._tag === "Pending" ? { headers: oauthNoStoreHeaders() } : undefined);
  }
  return data(
    { oauthError: false, oauth: oauth._tag === "Pending" },
    oauth._tag === "Pending" ? { headers: oauthNoStoreHeaders() } : undefined,
  );
}

export async function action({ request }: Route.ActionArgs) {
  const oauth = inspectPendingOAuthRequest(request);
  const oauthError = (status: number, message: string) =>
    data({ error: message }, { status, headers: oauthNoStoreHeaders() });
  const loginError = (message: string) =>
    oauth._tag === "Pending"
      ? data({ error: message }, { headers: oauthNoStoreHeaders() })
      : { error: message };
  if (oauth._tag === "Invalid") {
    return oauthError(400, "OAuth-forespørselen er ugyldig. Start tilkoblingen på nytt.");
  }
  if (oauth._tag === "Pending" && !hasTrustedActionOrigin(request)) {
    return oauthError(403, "OAuth-forespørselen ble avvist.");
  }
  const form = await request.formData();
  const email = form.get("email")?.toString() ?? "";
  const password = form.get("password")?.toString() ?? "";

  if (!email || !password) {
    return loginError("E-post og passord er påkrevd");
  }

  const result = await signInWithEmail(
    request,
    email,
    password,
    oauth._tag === "Pending" ? oauth.pending.raw : undefined,
  );
  switch (result._tag) {
    case "Authenticated": {
      if (oauth._tag !== "Pending") {
        return redirect(safeRedirect(form.get("redirectTo")), {
          headers: result.headers,
        });
      }
      const cookie = sessionCookieFromResponse(result.headers);
      if (result.continuation === undefined || cookie === undefined) {
        return oauthError(502, "OAuth-forespørselen kunne ikke fortsette.");
      }
      try {
        const location = await guardOAuthContinuation(
          request,
          oauth.pending,
          result.continuation,
          cookie,
        );
        return redirect(location, { headers: oauthNoStoreHeaders(result.headers) });
      } catch {
        return oauthError(502, "OAuth-forespørselen kunne ikke fortsette.");
      }
    }
    case "InvalidOAuthRequest":
      return oauthError(400, "OAuth-forespørselen er ugyldig. Start tilkoblingen på nytt.");
    case "RateLimited":
      return loginError("For mange innloggingsforsøk. Prøv igjen om 15 minutter.");
    case "InvalidCredentials":
      return loginError("Feil e-post eller passord");
    case "Unavailable":
      return loginError("Tjenesten er midlertidig utilgjengelig. Prøv igjen senere.");
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Login() {
  const actionData = useActionData<typeof action>();
  const loaderData = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const sessionExpired = searchParams.get("expired") === "true";
  const passwordReset = searchParams.get("reset") === "true";
  const [showPassword, setShowPassword] = useState(false);

  return (
    <main className="grid h-dvh place-items-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-lg bg-white p-8 shadow-md">
        <div className="text-center">
          <h1 className="font-bold text-2xl">Vektorprogrammet</h1>
          <p className="mt-1 text-gray-500 text-sm">Logg inn på dashbordet</p>
          {loaderData.oauthError && (
            <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-red-700 text-sm">
              OAuth-forespørselen er ugyldig. Start tilkoblingen på nytt.
            </p>
          )}
        </div>

        {!loaderData.oauthError && (
          <Form method="post" className="space-y-4">
            {!loaderData.oauth && (
              <input type="hidden" name="redirectTo" value={searchParams.get("redirectTo") ?? ""} />
            )}
            {passwordReset && (
              <p className="rounded bg-green-50 p-2 text-center text-green-700 text-sm">
                Passordet ditt er tilbakestilt. Logg inn med ditt nye passord.
              </p>
            )}
            {sessionExpired && (
              <p className="rounded bg-amber-50 p-2 text-center text-amber-700 text-sm">
                Økten din har utløpt. Vennligst logg inn på nytt.
              </p>
            )}
            {actionData?.error && (
              <p role="alert" className="rounded bg-red-50 p-2 text-center text-red-700 text-sm">
                {actionData.error}
              </p>
            )}

            <div className="space-y-2">
              <label htmlFor="email" className="font-medium text-sm">
                E-post
              </label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>

            <div className="space-y-2">
              <label htmlFor="password" className="font-medium text-sm">
                Passord
              </label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  className="absolute top-1/2 right-3 -translate-y-1/2 text-gray-600 text-xs hover:text-gray-700"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? "Skjul" : "Vis"}
                </button>
              </div>
            </div>

            <Button type="submit" className="w-full">
              Logg inn
            </Button>

            <Link
              to="/glemt-passord"
              className="block text-center text-sm text-gray-500 hover:text-gray-700"
            >
              Glemt passord?
            </Link>
          </Form>
        )}
      </div>
    </main>
  );
}
