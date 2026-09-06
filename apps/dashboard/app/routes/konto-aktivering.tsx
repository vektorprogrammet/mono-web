import { OnboardingClaim } from "@vektorprogrammet/domain/onboarding";
import { Schema } from "effect";
import { useSyncExternalStore } from "react";
import { data, Link, useFetcher, useLoaderData } from "react-router";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { createAuthenticatedClient } from "../lib/api.server";
import { hasAuthenticatedSession, requireAuth } from "../lib/auth.server";
import { nativeProblemFrom } from "../lib/native-problem";
import type { Route } from "./+types/konto-aktivering";
const privateData = <T,>(value: T, status = 200) =>
  data(value, {
    status,
    headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" },
  });
export async function loader({ request }: Route.LoaderArgs) {
  return privateData({ signedIn: await hasAuthenticatedSession(request) });
}
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  try {
    const mode = form.get("mode");
    const password = form.get("password");
    if (mode === "NewAccount" && password !== form.get("confirmation"))
      return privateData({ ok: false, message: "Passordene må være like." }, 422);
    const payload = Schema.decodeUnknownSync(OnboardingClaim)(
      mode === "NewAccount"
        ? { mode, token: form.get("token"), password }
        : { mode, token: form.get("token") },
    );
    const cookie = payload.mode === "ExistingAccount" ? await requireAuth(request) : "";
    const client = createAuthenticatedClient(cookie, request);
    if (payload.mode === "NewAccount") await client.onboarding.claim({ payload });
    else await client.onboarding.claim({ payload });
    return privateData({
      ok: true,
      message: "Kontoen er knyttet til søknaden. Logg inn og be om tilknytning under Assistenter.",
    });
  } catch (error) {
    const problem = nativeProblemFrom(error);
    return privateData(
      {
        ok: false,
        message:
          problem?.code === "onboarding.sign-in-required"
            ? "Logg inn på din eksisterende konto, eller bruk glemt passord. Åpne deretter invitasjonen igjen."
            : "Invitasjonen kunne ikke brukes. Den kan være utløpt eller allerede brukt. Be om en ny invitasjon.",
      },
      400,
    );
  }
}
const subscribe = (changed: () => void) => {
  window.addEventListener("hashchange", changed);
  return () => window.removeEventListener("hashchange", changed);
};
const snapshot = () => window.location.hash.slice(1);
export default function ClaimAccount() {
  const { signedIn } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const token = useSyncExternalStore(subscribe, snapshot, () => "");
  const busy = fetcher.state !== "idle";
  return (
    <main className="mx-auto max-w-lg space-y-5 p-6">
      <h1 className="text-2xl font-semibold">Knytt søknaden til din konto</h1>
      <p>Invitasjonen gjelder i 24 timer. Å åpne denne siden endrer ikke kontoen.</p>
      {fetcher.data?.ok ? (
        <>
          <p role="status">{fetcher.data.message}</p>
          <Link to={signedIn ? "/dashboard/assistenter" : "/login"}>Fortsett</Link>
        </>
      ) : (
        <fetcher.Form
          method="post"
          action="/konto-aktivering"
          className="space-y-4"
          data-pending={busy}
        >
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="mode" value={signedIn ? "ExistingAccount" : "NewAccount"} />
          {signedIn ? (
            <p>
              Du er innlogget. Søknaden knyttes til din nåværende konto; passord og profil beholdes.
            </p>
          ) : (
            <>
              <p>
                Har du konto fra før? <Link to="/login">Logg inn</Link> eller bruk{" "}
                <Link to="/glemt-passord">glemt passord</Link>, og åpne invitasjonen igjen.
              </p>
              <label className="block" htmlFor="onboarding-password">
                Nytt passord
              </label>
              <Input
                id="onboarding-password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
              <label className="block" htmlFor="onboarding-confirmation">
                Gjenta passord
              </label>
              <Input
                id="onboarding-confirmation"
                name="confirmation"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </>
          )}
          <Button disabled={busy || !token}>
            {busy ? "Lagrer …" : signedIn ? "Knytt min konto" : "Opprett konto"}
          </Button>
          <p role="status">{busy ? "" : fetcher.data?.message}</p>
        </fetcher.Form>
      )}
    </main>
  );
}
