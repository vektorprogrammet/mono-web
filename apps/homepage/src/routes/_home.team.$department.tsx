import { useOutletContext } from "react-router";
import { TeamTabs } from "~/components/team-tabs";
import type { TeamDirectory } from "~/lib/team-directory";
import type { Route } from "./+types/_home.team.$department";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Team({ params }: Route.ComponentProps) {
  const directory = useOutletContext<TeamDirectory>();

  return <TeamTabs directory={directory} selectedSlug={params.department} />;
}
