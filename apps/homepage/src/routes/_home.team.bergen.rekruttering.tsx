import { TeamTemplate } from "@/components/team-template";
import { getDevTeamMembers } from "~/lib/dev-content";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Rekruttering() {
  return (
    <div className="mx-auto mt-5 mb-20 flex max-w-screen-lg flex-col">
      <TeamTemplate
        name="Rekruttering"
        mail="dev@example.invalid"
        text="I rekruttering jobber vi med å skaffe nye vektorassistenter!"
        members={getDevTeamMembers("bergen-rekruttering")}
      />
      <div className="m-5 mt-20 text-left font-sans text-black text-lg">
        I rekrutteringsteamet har vi ansvaret for å skaffe nye og gode
        vektorassistenter. Hovedoppgavene som medlem av rekrutteringsteamet
        består av å stå på stand, bleste i forelesninger og intervjue nye
        søkere. I tillegg har vi også ansvar de sosiale og faglige
        arrangementene vektorprogrammet arrangerer.
      </div>
    </div>
  );
}
