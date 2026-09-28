import { IdempotencyKey, OnboardingCommand, OnboardingScope, StrongETag } from "@vektorprogrammet/rpc";
import { Schema } from "effect";
import { useState } from "react";
import { Form, data, useFetcher, useLoaderData } from "react-router";
import { Button } from "../components/ui/button";
import { callNative } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import { formText } from "../lib/form-text";
import type { Route } from "./+types/dashboard.onboarding";

const privateData = <T,>(value: T, status = 200) =>
  data(value, { status, headers: { "cache-control": "private, no-store" } });

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);

  const scopes = await callNative(cookie, request, (client) => client["placements.listScopes"]());
  const departments = scopes.departments.filter((d) => d.canManage);

  const departmentId = new URL(request.url).searchParams.get("departmentId") ?? "";

  const board =
    departmentId === ""
      ? null
      : await callNative(cookie, request, (client) =>
          client["onboarding.readBoard"](Schema.decodeSync(OnboardingScope)({ departmentId })),
        );

  return privateData({ departments, departmentId, board });
}

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const form: FormData = await request.formData();

  try {
    const scope = Schema.decodeUnknownSync(OnboardingScope)({
      departmentId: form.get("departmentId"),
    });

    const command = {
      departmentId: scope.departmentId,
      idempotencyKey: Schema.decodeUnknownSync(IdempotencyKey)(form.get("commandId")),
      ifMatch: Schema.decodeUnknownSync(StrongETag)(form.get("etag")),
      request: Schema.decodeUnknownSync(OnboardingCommand)({
        applicationId: form.get("applicationId"),
        action: form.get("action"),
      }),
    };

    await callNative(cookie, request, (client) => client["onboarding.command"](command));

    return privateData({
      ok: true,
      commandId: formText(form, "commandId"),
      message: "Endringen er lagret. Leveringsstatus vises i oversikten.",
    });
  } catch {
    return privateData(
      { ok: false, message: "Endringen kunne ikke lagres. Last oversikten på nytt og prøv igjen." },
      409,
    );
  }
}

function InvitationForm({
  item,
  departmentId,
  etag,
}: {
  item: NonNullable<Awaited<ReturnType<typeof loader>>["data"]["board"]>["items"][number];
  departmentId: string;
  etag: string;
}) {
  const fetcher = useFetcher<typeof action>();
  const [commandId, setCommandId] = useState(() => crypto.randomUUID());
  const [signature, setSignature] = useState("");
  const busy = fetcher.state !== "idle";

  if (fetcher.data?.ok && "commandId" in fetcher.data && fetcher.data.commandId === commandId) {
    setCommandId(crypto.randomUUID());
    setSignature("");
  }

  return (
    <fetcher.Form
      method="post"
      data-pending={busy}
      onSubmit={(event) => {
        if (busy || event.currentTarget.dataset.pending === "true") {
          event.preventDefault();

          return;
        }

        event.currentTarget.dataset.pending = "true";
        const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;

        const next = JSON.stringify([
          item.applicationId,
          etag,
          submitter instanceof HTMLButtonElement ? submitter.value : "",
        ]);

        if (next !== signature) {
          const key = crypto.randomUUID();
          const field = event.currentTarget.elements.namedItem("commandId");

          if (field instanceof HTMLInputElement) field.value = key;
          setCommandId(key);
          setSignature(next);
        }
      }}
    >
      <input type="hidden" name="departmentId" value={departmentId} />
      <input type="hidden" name="applicationId" value={item.applicationId} />
      <input type="hidden" name="etag" value={etag} />
      <input type="hidden" name="commandId" value={commandId} />
      <fieldset disabled={busy || item.state === "Linked"} className="flex flex-wrap gap-2">
        <legend className="sr-only">
          Invitasjon for {item.firstName} {item.lastName}
        </legend>
        <Button name="action" value="Issue">
          {item.state === "Absent" ? "Inviter" : "Send ny invitasjon"}
        </Button>
        <Button name="action" value="Revoke" variant="outline">
          Trekk tilbake
        </Button>
        <Button name="action" value="RetryDelivery" variant="outline">
          Prøv levering igjen
        </Button>
      </fieldset>
      <p role="status">{busy ? "Lagrer …" : fetcher.data?.message}</p>
    </fetcher.Form>
  );
}

export default function Onboarding() {
  const { departments, departmentId, board } = useLoaderData<typeof loader>();

  return (
    <section aria-labelledby="onboarding-title" className="space-y-6 p-4">
      <h1 id="onboarding-title" className="text-2xl font-semibold">
        Søkerkontoer
      </h1>
      <p>
        Inviter søkere til å opprette eller knytte sin egen konto. Tilknytning og skoleplassering
        godkjennes separat.
      </p>
      <Form method="get" className="flex flex-wrap items-end gap-3">
        <label>
          Avdeling
          <select
            name="departmentId"
            defaultValue={departmentId}
            required
            className="block rounded border p-2"
          >
            <option value="">Velg avdeling</option>
            {departments.map((d) => (
              <option key={d.departmentId} value={d.departmentId}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <Button>Vis søkere</Button>
      </Form>
      {board?.items.map((item) => (
        <article key={item.applicationId} className="space-y-2 rounded border p-4">
          <h2 className="font-semibold">
            {item.firstName} {item.lastName}
          </h2>
          <p>
            Status: {item.state}. Levering: {item.delivery}.
          </p>
          <InvitationForm
            key={item.applicationId + board.etag}
            item={item}
            departmentId={departmentId}
            etag={board.etag}
          />
        </article>
      ))}
    </section>
  );
}
