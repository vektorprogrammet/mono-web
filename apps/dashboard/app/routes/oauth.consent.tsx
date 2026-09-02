import { Button } from "@/components/ui/button";
import { Form, data, redirect, useLoaderData } from "react-router";
import { loadOAuthConsent, oauthNoStoreHeaders, submitOAuthConsent } from "../lib/oauth.server";
import type { Route } from "./+types/oauth.consent";

export async function loader({ request }: Route.LoaderArgs) {
  const { view } = await loadOAuthConsent(request);
  return data(view, { headers: oauthNoStoreHeaders() });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const decisions = form.getAll("decision");
  if (decisions.length !== 1 || (decisions[0] !== "accept" && decisions[0] !== "deny")) {
    throw Response.json(
      { error: "OAuth-forespørselen kunne ikke behandles. Start tilkoblingen på nytt." },
      { status: 400, headers: oauthNoStoreHeaders() },
    );
  }
  const result = await submitOAuthConsent(request, decisions[0] === "accept");
  return redirect(result.location, { headers: result.headers });
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function OAuthConsent() {
  const consent = useLoaderData<typeof loader>();
  return (
    <main className="grid min-h-dvh place-items-center bg-gray-50 px-4 py-8">
      <section
        aria-labelledby="oauth-consent-title"
        className="w-full max-w-lg space-y-6 rounded-lg bg-white p-8 shadow-md"
      >
        <div className="space-y-2">
          <h1 id="oauth-consent-title" className="font-bold text-2xl">
            Gi tilgang til {consent.clientName}?
          </h1>
          <p className="text-gray-600 text-sm">
            Dette er en {consent.clientKind === "public" ? "offentlig" : "konfidensiell"}{" "}
            OAuth-klient. Du blir sendt tilbake til{" "}
            <code className="break-all rounded bg-gray-100 px-1 py-0.5">
              {consent.redirectOrigin}
            </code>
            .
          </p>
        </div>

        <div className="space-y-3">
          <h2 className="font-semibold text-lg">Klienten ber om å få</h2>
          <ul className="list-disc space-y-2 pl-5 text-gray-700 text-sm">
            {consent.scopes.includes("native-api") && (
              <li>Access the Vektorprogrammet native API</li>
            )}
            {consent.scopes.includes("offline_access") && (
              <li>Stay connected for up to 30 days, with use at least every 7 days</li>
            )}
          </ul>
          <p className="rounded bg-gray-50 p-3 text-gray-700 text-sm">
            Ressurs: <span className="font-medium">{consent.resourceName}</span>
          </p>
        </div>

        <Form method="post" className="grid gap-3 sm:grid-cols-2">
          <Button type="submit" name="decision" value="accept">
            Godta
          </Button>
          <Button type="submit" name="decision" value="deny" variant="outline">
            Avslå
          </Button>
        </Form>
      </section>
    </main>
  );
}
