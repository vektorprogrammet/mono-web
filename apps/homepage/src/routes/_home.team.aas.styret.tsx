import { TeamTemplate } from "@/components/team-template";
import { getDevTeamMembers } from "~/lib/dev-content";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Styret() {
  return (
    <div className="mx-auto mt-5 mb-20 flex max-w-screen-lg flex-col">
      <TeamTemplate
        name="Styret"
        mail="dev@example.invalid"
        text="Ansvarlig for driften av Vektorprogrammet i Ås."
        members={getDevTeamMembers("aas-styre")}
      />

      <div className="m-5 mt-20 text-left font-sans text-black text-lg">
        Styret består av leder, nestleder og ledere for de ulike teamene
        (sponsor/økonomi, rekruttering/profilering/evaluering, skolekoordinering
        og sosialt). I løpet av de månedlige møtene gjennomgås månedens, samt
        fremtidige saker, som kan være alt fra å organisere sosiale aktiviteter
        til å løse problemer som oppstår under driften av Vektorprogrammet i Ås.
        Hver av medlemmene i styret (med unntak av leder og nestleder) har
        ansvar for et team bestående av 3 til 6 medlemmer som hjelper til med å
        utføre ulike oppgaver for sitt team.
      </div>
      <div className="m-3">
        {/*! TODO: FIX */}
        {/* biome-ignore lint/a11y/useAltText: Temporary ignore for ci/cd */}
        <img
          src="/images/teacher2.png"
          className="m-5 mx-auto h-auto content-center sm:max-w-2xl"
        />
      </div>
    </div>
  );
}
