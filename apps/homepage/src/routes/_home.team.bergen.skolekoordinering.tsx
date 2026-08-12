import { TeamTemplate } from "@/components/team-template";
import { getDevTeamMembers } from "~/lib/dev-content";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Skolekoordinering() {
  return (
    <div className="mx-auto mt-5 mb-20 flex max-w-screen-lg flex-col">
      <TeamTemplate
        name="Skolekoordinering"
        mail="dev@example.invalid"
        text="Skolekoordinering fungerer som et bindeledd mellom skolene og vektorassistentene gjennom semesteret."
        members={getDevTeamMembers("bergen-skole")}
      />

      <div className="m-5 mt-20 text-left font-sans text-black text-lg">
        Skolekoordineringsteamet har ansvaret for å fordele vektorassistentene
        på samarbeidsskolene våre, og opprettholde kontakten med disse
        semesteret gjennom. I praksis vil det si å være tilgjengelig på mail,
        skaffe eventuelle vikarer for vektorassistenter som ikke kan møte, og
        videreformidle informasjon. Skulle det oppstå noe vektorassistentene har
        behov for å si i fra om, skal det være lav terskel for å kontakte
        skolekoordineringsteamet.
      </div>
    </div>
  );
}
