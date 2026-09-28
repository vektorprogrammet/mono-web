import { callHomepageNative } from "./api.server";
import { projectTeamDirectory, type TeamDirectory } from "./team-directory";

/**
 * Server-only team page read. Every render reads departments, teams, and intake
 * state afresh and concurrently. Departments and teams are required: a failed
 * read or an unroutable department is a 503.
 * Intake state is optional: a failed intake read renders every team without an
 * application link.
 */
export async function loadTeamDirectory(): Promise<TeamDirectory> {
  const [departments, teams, intakes] = await Promise.all([
    callHomepageNative((client) => client["organization.listDepartments"]()).catch(
      () => undefined,
    ),
    callHomepageNative((client) => client["organization.listTeams"]()).catch(() => undefined),
    callHomepageNative((client) =>
      client["team-applications.listTeamApplicationIntakes"](),
    ).catch(() => null),
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
