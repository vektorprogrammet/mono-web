import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Form, Link, redirect, useActionData, useSearchParams } from "react-router";
import { createClient, apiUrl, RateLimitedError } from "@vektorprogrammet/sdk";
import {
  createAuthCookie,
  getToken,
} from "../lib/auth.server";
import type { Route } from "./+types/login";

export async function loader({ request }: Route.LoaderArgs) {
  const token = getToken(request);
  if (token) throw redirect("/dashboard");
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const username = form.get("username")?.toString() ?? "";
  const password = form.get("password")?.toString() ?? "";

  if (!username || !password) {
    return { error: "Brukernavn og passord er påkrevd" };
  }

  const sdk = createClient(apiUrl);
  try {
    const { token } = await sdk.auth.login(username, password);
    return redirect("/dashboard", {
      headers: { "Set-Cookie": createAuthCookie(token) },
    });
  } catch (e) {
    if (e instanceof RateLimitedError) {
      return { error: "For mange innloggingsforsøk. Prøv igjen om 15 minutter." };
    }
    return { error: "Feil brukernavn eller passord" };
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Login() {
  const actionData = useActionData<typeof action>();
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
        </div>

        <Form method="post" className="space-y-4">
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
            <p className="rounded bg-red-50 p-2 text-center text-red-600 text-sm">
              {actionData.error}
            </p>
          )}

          <div className="space-y-2">
            <label htmlFor="username" className="font-medium text-sm">
              Brukernavn eller e-post
            </label>
            <Input
              id="username"
              name="username"
              type="text"
              autoComplete="username"
              required
            />
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
                className="absolute top-1/2 right-3 -translate-y-1/2 text-gray-400 text-xs hover:text-gray-600"
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
      </div>
    </main>
  );
}
