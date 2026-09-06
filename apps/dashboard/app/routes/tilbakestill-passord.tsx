import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  Link,
  data,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import {
  createPasswordRecoveryClient,
  PasswordRecoveryError,
  requireNativePasswordRecovery,
} from "../server/password-recovery.server";
import type { Route } from "./+types/tilbakestill-passord";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return data(
    { ready: !url.searchParams.has("error") && !!url.searchParams.get("token") },
    { headers },
  );
}
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const token = form.get("token");
  const password = form.get("password");
  if (typeof token !== "string" || !token) return data({ state: "InvalidOrExpired" }, { headers });
  if (typeof password !== "string" || password.length < 12 || password !== form.get("confirmation"))
    return data({ state: "Rejected" }, { headers });
  try {
    requireNativePasswordRecovery();
    await createPasswordRecoveryClient(request).resetPassword(token, password);
  } catch (error) {
    return data(
      { state: error instanceof PasswordRecoveryError ? error.outcome : "OutcomeUnknown" },
      { headers },
    );
  }
  return redirect("/login?reset=true", { headers });
}
export default function PasswordReset() {
  const { ready } = useLoaderData<typeof loader>();
  const resetToken = useRef(
    typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("token"),
  );
  const result = useActionData<typeof action>();
  const pending = useNavigation().state !== "idle";
  const state = result?.state ?? (ready ? "Ready" : "InvalidOrExpired");
  return (
    <main className="grid min-h-dvh place-items-center bg-gray-50">
      <section className="w-full max-w-sm space-y-4 rounded bg-white p-8">
        <h1 className="text-2xl font-bold">Tilbakestill passord</h1>
        {state === "InvalidOrExpired" ? (
          <p>Lenken er ugyldig eller utløpt.</p>
        ) : state === "OutcomeUnknown" ? (
          <p>Resultatet er usikkert. Be om en ny lenke før du prøver igjen.</p>
        ) : (
          <Form
            method="post"
            action="/tilbakestill-passord"
            onSubmit={(event) => {
              const token = resetToken.current;
              const field = event.currentTarget.elements.namedItem("token");
              if (field instanceof HTMLInputElement) field.value = token ?? "";
            }}
          >
            <fieldset disabled={pending} className="space-y-4">
              <input type="hidden" name="token" defaultValue="" />
              {state === "Rejected" && (
                <p role="alert">Passordene må være like og ha minst 12 tegn.</p>
              )}
              <label htmlFor="password">Nytt passord</label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
              <label htmlFor="confirmation">Gjenta passord</label>
              <Input
                id="confirmation"
                name="confirmation"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
              />
              <Button type="submit">{pending ? "Lagrer …" : "Lagre passord"}</Button>
            </fieldset>
          </Form>
        )}
        <Link to="/glemt-passord">Be om ny lenke</Link>
      </section>
    </main>
  );
}
