import { useOutletContext } from "react-router";
import { TeamTabs } from "~/components/team-tabs";
import type { TeamDirectory } from "~/lib/team-directory";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Team() {
  const directory = useOutletContext<TeamDirectory>();

  return <TeamTabs directory={directory} />;
}
