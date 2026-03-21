import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, Link, redirect, useActionData } from "react-router";
import { createClient, apiUrl } from "@vektorprogrammet/sdk";
import type { Route } from "./+types/tilbakestill-passord.$code";

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const password = form.get("password")?.toString() ?? "";
  const confirmPassword = form.get("confirmPassword")?.toString() ?? "";

  if (!password || !confirmPassword) {
    return { error: "Begge passordfeltene er påkrevd" };
  }

  if (password !== confirmPassword) {
    return { error: "Passordene samsvarer ikke" };
  }

  if (password.length < 8) {
    return { error: "Passordet må være minst 8 tegn" };
  }

  const sdk = createClient(apiUrl);
  try {
    await sdk.auth.setPassword(params.code, password);
    throw redirect("/login?reset=true");
  } catch (e) {
    if (e instanceof Response) throw e;
    return { error: "Kunne ikke tilbakestille passordet. Lenken kan være ugyldig eller utløpt." };
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function TilbakestillPassord() {
  const actionData = useActionData<typeof action>();

  return (
    <main className="grid h-dvh place-items-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-lg bg-white p-8 shadow-md">
        <div className="text-center">
          <h1 className="font-bold text-2xl">Nytt passord</h1>
          <p className="mt-1 text-gray-500 text-sm">
            Skriv inn ditt nye passord
          </p>
        </div>

        <Form method="post" className="space-y-4">
          {actionData?.error && (
            <p className="rounded bg-red-50 p-2 text-center text-red-600 text-sm">
              {actionData.error}
            </p>
          )}

          <div className="space-y-2">
            <label htmlFor="password" className="font-medium text-sm">
              Nytt passord
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="confirmPassword" className="font-medium text-sm">
              Bekreft passord
            </label>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
            />
          </div>

          <Button type="submit" className="w-full">
            Tilbakestill passord
          </Button>

          <Link
            to="/login"
            className="block text-center text-sm text-gray-500 hover:text-gray-700"
          >
            Tilbake til innlogging
          </Link>
        </Form>
      </div>
    </main>
  );
}
