import { Link, useLoaderData } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.teamsoknader._index";

/** Every active team: the directory has no membership read, so the team page enforces access. */
export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  const [departments, teams] = await Promise.all([
    client.organization.listDepartments({ headers: {} }),
    client.organization.listTeams({ headers: {} }),
  ]).catch(() => [undefined, undefined] as const);

  if (departments?.body === undefined || teams?.body === undefined) {
    throw new Response("Teamoversikten er midlertidig utilgjengelig.", { status: 503 });
  }

  const collator = new Intl.Collator("nb");
  const activeTeams = teams.body.filter((team) => team.active);

  return {
    departments: departments.body
      .filter((department) => department.active)
      .map((department) => ({
        departmentId: department.departmentId,
        name: department.name,
        teams: activeTeams
          .filter((team) => team.departmentId === department.departmentId)
          .map((team) => ({ teamId: team.teamId, name: team.name }))
          .sort((left, right) => collator.compare(left.name, right.name)),
      }))
      .filter((department) => department.teams.length > 0)
      .sort((left, right) => collator.compare(left.name, right.name)),
  };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function TeamSoknaderChooser() {
  const { departments } = useLoaderData<typeof loader>();

  return (
    <section
      aria-labelledby="team-applications-chooser-title"
      className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 px-4 py-6"
    >
      <header className="space-y-2">
        <h1 id="team-applications-chooser-title" className="font-semibold text-2xl">
          Team-søknader
        </h1>
        <p className="text-muted-foreground">
          Velg teamet ditt for å lese søknadene. Bare nåværende medlemmer av et team får se
          søknadene til teamet.
        </p>
      </header>
      {departments.length === 0 ? (
        <p>Ingen aktive team er registrert.</p>
      ) : (
        departments.map((department) => (
          <section
            key={department.departmentId}
            aria-labelledby={`team-applications-department-${department.departmentId}`}
            className="space-y-3"
          >
            <h2
              id={`team-applications-department-${department.departmentId}`}
              className="font-semibold text-lg"
            >
              {department.name}
            </h2>
            <ul className="grid gap-2">
              {department.teams.map((team) => (
                <li key={team.teamId}>
                  <Link
                    to={encodeURIComponent(team.teamId)}
                    relative="path"
                    prefetch="intent"
                    className="block break-words rounded-md border px-4 py-3 font-medium underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    Søknader til {team.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
