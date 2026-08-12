import { TeamTemplate } from "@/components/team-template";
import { getDevTeamMembers } from "~/lib/dev-content";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function SponsorOkonomi() {
  return (
    <div className="mx-auto mt-5 mb-20 flex max-w-screen-lg flex-col">
      <TeamTemplate
        name="Sponsor og økonomi"
        mail="dev@example.invalid"
        text="Har ansvaret for økonomien og sponsorene til Vektorprogrammet Ås."
        members={getDevTeamMembers("aas-sponsor")}
      />

      <div className="m-5 mt-20 text-left font-sans text-black text-lg">
        Teamet har ansvar for å holde oversikt over økonomien til
        Vektorprogrammet på Ås. I tillegg jobber de også med å skaffe sponsorer
        i løpet av semesteret ved å ta kontakt med bedrifter i nærområdet.
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
