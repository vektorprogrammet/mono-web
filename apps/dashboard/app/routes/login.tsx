import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Form, redirect, useActionData } from "react-router";
import { createClient, apiUrl } from "@vektorprogrammet/sdk";
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

  const client = createClient(apiUrl);
  const { data, error, response } = await client.POST("/api/login", {
    body: { username, password },
  });

  if (error || !data?.token) {
    if (response?.status === 429) {
      return { error: "For mange innloggingsforsøk. Prøv igjen om 15 minutter." };
    }
    return { error: "Feil brukernavn eller passord" };
  }

  return redirect("/dashboard", {
    headers: { "Set-Cookie": createAuthCookie(data.token) },
  });
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Login() {
  const actionData = useActionData<typeof action>();
  const [showPassword, setShowPassword] = useState(false);

  return (
    <main className="grid h-dvh place-items-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-lg bg-white p-8 shadow-md">
        <div className="text-center">
          <h1 className="font-bold text-2xl">Vektorprogrammet</h1>
          <p className="mt-1 text-gray-500 text-sm">Logg inn på dashbordet</p>
        </div>

        <Form method="post" className="space-y-4">
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
        </Form>
      </div>
    </main>
  );
}
