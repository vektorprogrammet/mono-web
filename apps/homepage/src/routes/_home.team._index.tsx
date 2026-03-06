import { useOutletContext } from "react-router";
import { TeamTabs } from "~/components/team-tabs";
import type { TeamLoaderData } from "~/components/team-tabs";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Team() {
  const { teams, departments } = useOutletContext<TeamLoaderData>();
  return <TeamTabs department="Trondheim" teams={teams} departments={departments} />;
}
