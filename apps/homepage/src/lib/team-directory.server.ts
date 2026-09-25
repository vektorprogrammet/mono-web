import { createHomepageApiClient } from "./api.server";
import { projectTeamDirectory, type TeamDirectory } from "./team-directory";

/**
 * Server-only team page read. Every render reads departments, teams, and intake
 * state afresh and concurrently. Departments and teams are required: a failed
 * read, a 304 response without a body, or an unroutable department is a 503.
 * Intake state is optional: a failed intake read renders every team without an
 * application link.
 */
export async function loadTeamDirectory(): Promise<TeamDirectory> {
  const client = createHomepageApiClient();

  const [departments, teams, intakes] = await Promise.all([
    client.organization.listDepartments({ headers: {} }).then(
      (result) => result.body,
      () => undefined,
    ),
    client.organization.listTeams({ headers: {} }).then(
      (result) => result.body,
      () => undefined,
    ),
    client["team-applications"].listTeamApplicationIntakes().then(
      (result) => result.body,
      () => null,
    ),
  ]);

  const directory =
    departments === undefined || teams === undefined
      ? undefined
      : projectTeamDirectory(departments, teams, intakes);

  if (directory === undefined) {
    throw new Response("Teamoversikten er midlertidig utilgjengelig.", { status: 503 });
  }

  return directory;
}
