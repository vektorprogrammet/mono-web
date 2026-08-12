import { TeamTemplate } from "@/components/team-template";
import { getDevTeamMembers } from "~/lib/dev-content";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Styret() {
  return (
    <div className="mx-auto mt-5 mb-20 flex max-w-screen-lg flex-col">
      <TeamTemplate
        name="Styret"
        mail="dev@example.invalid"
        text="Ansvarlig for driften av Vektorprogrammet i Trondheim."
        members={getDevTeamMembers("trondheim-styre")}
      />

      <div className="m-5 mt-20 text-left font-sans text-black text-lg">
        Styret består av leder, nestleder, sekretær og alle teamlederne. I løpet
        av de ukentlige møtene gjennomgåes ukens og fremtidige saker, som kan
        være alt fra å organisere sosiale aktiviteter til å løse problemer som
        oppstår under driften av Vektorprogrammet i Trondheim. På denne måten
        får alle team oppdatert informasjon om hverandre, slik at effektivt
        sammarbeid muliggjøres.
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
