import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, Link, useActionData } from "react-router";
import { createClient, apiUrl } from "@vektorprogrammet/sdk";
import type { Route } from "./+types/glemt-passord";

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const email = form.get("email")?.toString() ?? "";

  if (!email) {
    return { error: "E-post er påkrevd", success: false };
  }

  const client = createClient(apiUrl);
  const { error } = await client.POST("/api/password_resets", {
    body: { email },
  });

  if (error) {
    return { error: "Noe gikk galt. Vennligst prøv igjen.", success: false };
  }

  return { success: true, error: null };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function GlemtPassord() {
  const actionData = useActionData<typeof action>();

  return (
    <main className="grid h-dvh place-items-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-lg bg-white p-8 shadow-md">
        <div className="text-center">
          <h1 className="font-bold text-2xl">Glemt passord</h1>
          <p className="mt-1 text-gray-500 text-sm">
            Skriv inn e-postadressen din for å tilbakestille passordet
          </p>
        </div>

        {actionData?.success ? (
          <div className="space-y-4">
            <p className="rounded bg-green-50 p-3 text-center text-green-700 text-sm">
              Vi har sendt en e-post med instruksjoner for å tilbakestille
              passordet ditt.
            </p>
            <Link
              to="/login"
              className="block text-center text-sm text-gray-500 hover:text-gray-700"
            >
              Tilbake til innlogging
            </Link>
          </div>
        ) : (
          <Form method="post" className="space-y-4">
            {actionData?.error && (
              <p className="rounded bg-red-50 p-2 text-center text-red-600 text-sm">
                {actionData.error}
              </p>
            )}

            <div className="space-y-2">
              <label htmlFor="email" className="font-medium text-sm">
                E-post
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
              />
            </div>

            <Button type="submit" className="w-full">
              Send tilbakestillingslenke
            </Button>

            <Link
              to="/login"
              className="block text-center text-sm text-gray-500 hover:text-gray-700"
            >
              Tilbake til innlogging
            </Link>
          </Form>
        )}
      </div>
    </main>
  );
}
