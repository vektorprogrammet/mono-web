import { useOutletContext } from "react-router";
import { TeamTabs, type TeamLoaderData } from "~/components/team-tabs";
import { type DepartmentPretty, departments } from "~/lib/types";
import type { Route } from "./+types/_home.team.$department";
import { Match } from "effect";


// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Team({ params }: Route.ComponentProps) {
  const { teams, departments: apiDepartments } = useOutletContext<TeamLoaderData>();

  const activeDepartment: DepartmentPretty =
    Match.value(params.department).pipe(Match.when("hovedstyret", () => departments.hovedstyret), Match.when("bergen", () => departments.bergen), Match.when("aas", () => departments.aas), Match.orElse(() => departments.trondheim));

  return <TeamTabs department={activeDepartment} teams={teams} departments={apiDepartments} />;
}
