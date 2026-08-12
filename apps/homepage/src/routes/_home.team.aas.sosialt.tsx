import { TeamTemplate } from "@/components/team-template";
import { getDevTeamMembers } from "~/lib/dev-content";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Sosialt() {
  return (
    <div className="mx-auto mt-5 mb-20 flex max-w-screen-lg flex-col">
      <TeamTemplate
        name="Sosialt"
        mail="dev@example.invalid"
        text="Vi arrangerer sosiale arrangementer for assistenter og sørger for at alle trives i vervet."
        members={getDevTeamMembers("aas-sosialt")}
      />
    </div>
  );
}
