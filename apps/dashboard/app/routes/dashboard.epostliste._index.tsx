import { MailingListQuery, type PlacementScopes } from "@vektorprogrammet/http-api";
import { Match, Schema } from "effect";
import { Form, data, useLoaderData, useNavigation } from "react-router";
import { Button } from "../components/ui/button";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import { nativeProblemFrom } from "../lib/native-problem";
import { semesterLabel } from "../lib/semester-label";
import type { Route } from "./+types/dashboard.epostliste._index";

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const params = new URL(request.url).searchParams;
  const department = params.get("department") ?? "";
  const semester = params.get("semester") ?? "";
  const type = params.get("type") ?? "assistants";
  let scopes: typeof PlacementScopes.Type | null = null;

  try {
    scopes = (await client.placements.listScopes()).body;

    const query = Schema.decodeUnknownSync(Schema.Struct(MailingListQuery))({
      department: department || undefined,
      semester: semester || undefined,
      type,
    });

    const lists = (await client.organization.listMailingLists({ query })).body;
    const emails = [...new Set(lists.flatMap((list) => list.emails))];

    return data(
      { scopes, department, semester, type, emails, error: null },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (cause) {
    const problem = nativeProblemFrom(cause);

    const error = Match.value(problem?.code).pipe(
      Match.when(
        "authority.denied",
        () => "Du har ikke tilgang til e-postlisten for denne avdelingen.",
      ),
      Match.when(
        "organization.invalid-reference",
        () => "Avdeling eller semester er ikke tilgjengelig. Velg et semester fra listen.",
      ),
      Match.orElse(() => "E-postlisten kunne ikke lastes. Prøv igjen."),
    );

    return data(
      { scopes, department, semester, type, emails: null, error },
      { status: problem?.status ?? 503, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export default function Epostliste() {
  const { scopes, department, semester, type, emails, error } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const departments = scopes?.departments ?? [];

  const selectClass =
    "w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <section
      className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-6 px-4 sm:px-6 lg:px-8"
      aria-labelledby="mailing-title"
    >
      <h1 id="mailing-title" className="font-semibold text-2xl">
        E-postliste
      </h1>
      <p>
        Velg avdeling, semester og mottakere. Listen bruker personenes nåværende kontaktadresser.
      </p>
      <Form
        method="get"
        key={`${department}:${semester}:${type}`}
        className="grid min-w-0 gap-4 sm:grid-cols-3"
        aria-busy={busy}
      >
        <div className="min-w-0">
          <label htmlFor="mailing-department" className="mb-1 block font-medium">
            Avdeling
          </label>
          <select
            id="mailing-department"
            name="department"
            defaultValue={department}
            className={selectClass}
          >
            <option value="">Alle avdelinger med tilgang</option>
            {department && !departments.some((entry) => entry.departmentId === department) && (
              <option value={department}>Valgt avdeling (ikke tilgjengelig)</option>
            )}
            {departments.map((entry) => (
              <option key={entry.departmentId} value={entry.departmentId}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="mailing-semester" className="mb-1 block font-medium">
            Semester
          </label>
          <select
            id="mailing-semester"
            name="semester"
            defaultValue={semester}
            className={selectClass}
          >
            <option value="">Nåværende semester</option>
            {semester && !scopes?.semesters.some((entry) => entry.semesterId === semester) && (
              <option value={semester}>Valgt semester (ikke tilgjengelig)</option>
            )}
            {scopes?.semesters.map((entry) => (
              <option key={entry.semesterId} value={entry.semesterId}>
                {semesterLabel(entry)}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label htmlFor="mailing-type" className="mb-1 block font-medium">
            Mottakere
          </label>
          <select id="mailing-type" name="type" defaultValue={type} className={selectClass}>
            <option value="assistants">Assistenter</option>
            <option value="team">Teammedlemmer</option>
            <option value="all">Assistenter og teammedlemmer</option>
          </select>
        </div>
        <Button type="submit" disabled={busy} className="sm:col-span-3 sm:justify-self-start">
          {busy ? "Laster …" : "Vis e-postliste"}
        </Button>
      </Form>
      {error !== null ? (
        <p role="alert">{error}</p>
      ) : (
        emails !== null && (
          <div className="flex min-w-0 flex-col gap-2" aria-live="polite">
            <p>
              {emails.length === 0
                ? "Ingen mottakere for dette utvalget."
                : `${emails.length} e-postadresser i utvalget.`}
            </p>
            {emails.length > 0 && (
              <>
                <label htmlFor="mailing-emails" className="font-medium">
                  E-postadresser
                </label>
                <p id="mailing-copy-help">
                  Marker og kopier adressene. Adressene er skilt med komma.
                </p>
                <textarea
                  id="mailing-emails"
                  readOnly
                  value={emails.join(", ")}
                  rows={8}
                  aria-describedby="mailing-copy-help"
                  className="w-full min-w-0 rounded-md border border-input bg-background p-3 text-sm"
                />
              </>
            )}
          </div>
        )
      )}
    </section>
  );
}
