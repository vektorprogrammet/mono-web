import { TeamTemplate } from "@/components/team-template";
import { getDevTeamMembers } from "~/lib/dev-content";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function IT() {
  return (
    <div className="mx-auto mt-5 mb-20 flex max-w-screen-lg flex-col">
      <TeamTemplate
        name="IT"
        mail="dev@example.invalid"
        text="IT-teamet utvikler og drifter Vektorprogrammets nettside og interne datasystemer."
        members={getDevTeamMembers("trondheim-it")}
      />

      <div className="mt-20 text-center font-sans text-3xl text-bold text-vektor-darblue">
        IT i Vektorprogrammet
      </div>

      <div className="mt-5 mr-4 mb-2 ml-4 grid items-center md:grid-cols-2">
        <div className="place-content-start font-sans text-black text-lg">
          <div className="mx-5 mt-5 text-start">
            Siden oppstarten har Vektorprogrammet opplevd en kraftig vekst i
            antall vektorassistenter, ungdomsskoler som deltar i programmet og
            teammedlemmer som jobber med å drive Vektorprogrammet. Denne veksten
            fører med seg en del utfordringer knyttet til organisering av
            Vektorprogrammet, og vi i IT-teamet jobber kontinuerlig med å hjelpe
            organisasjonen til å fungere på best mulig måte.
          </div>

          <div className="mx-5 mt-5 mb-10 text-start font-sans text-black text-lg">
            Vi jobber for alle avdelinger i Norge, men vi er lokalisert i
            Trondheim. Det betyr at vi får være med på alle sosiale
            arragangementer som Vektorprogrammet NTNU arrangerer!
          </div>
        </div>

        {/*! TODO: FIX */}
        {/* biome-ignore lint/a11y/useAltText: Temporary ignore for ci/cd */}
        <img
          className="mx-auto h-auto max-h-96 content-center sm:max-w-sm"
          src="/images/team/IT-Tor.png"
        />
      </div>

      <div className="mt-10 text-center font-sans text-3xl text-bold text-vektor-darblue">
        Arbeidet vårt
      </div>

      <div className="mx-5 mt-5 text-left font-sans text-black text-lg">
        Vi jobber med webutvikling på alle ledd i stacken. I fjor var det store
        prosjektet å redesigne den offentlige siden fullstendig fra bunnen av. I
        år planlegger vi å utvikle et assistentdashboard, som skal ta
        vektorassistenter gjennom hele opptaksprosessen og videre utover i
        vervet deres. Som medlem i IT-teamet vil du da lære masse om
        frontendprogrammering i javascriptrammeverket Vue.js samt UX design og
        hvordan man utformer en progressive webapp. Vi skal også utvide DevOps
        stacken vår med et avansert, automatisk stagingsystem for å rapidly
        deploye betaversjoner av nettsiden. Dette skal vi gjøre i det raskt
        voksende programmeringsspråket Go.
      </div>

      <div className="mx-5 mt-5 text-left font-sans text-black text-lg">
        Det her er bare en liten del av det vi har på agendaen og synes du noe
        av det høres spennende ut er det bare å sende oss en søknad! Du trenger
        ikke ha særlig kjennskap til noen av de overnevnte tingene, vi gir deg
        god oppfølging og hjelp!
      </div>

      <div className="m-3">
        {/*! TODO: FIX */}
        {/* biome-ignore lint/a11y/useAltText: Temporary ignore for ci/cd */}
        <img
          src="/images/teacher2.png"
          className="m-3 mx-auto mt-10 h-auto content-center sm:max-w-2xl"
        />
      </div>

      <div className="mt-10 text-center font-sans text-3xl text-bold text-vektor-darblue">
        Kjempegod erfaring
      </div>

      <div className="mx-5 mt-5 text-left font-sans text-black text-lg">
        Vi tilbyr IT-erfaring på høyt nivå og med lav terskel. Erfaring med
        teamarbeid er noe alle arbeidsgivere er ute etter, og vi kan tilby dette
        i bøtter og spann. Du vil også tilegne deg kunnskap om state-of-the art
        webteknologi og utviklingsmetodikk, du vil bli en mester i git og
        kanskje til og med lære deg litt sysadminoppgaver hvis du skulle ønske å
        skitne til fingrene.
      </div>

      <div className="mx-5 mt-5 text-left font-sans text-black text-lg">
        Er du kjent med minst én av disse tingene oppfordres du til å sende oss
        en søknad:
      </div>

      <div className="mt-3 font-sans text-black text-lg">
        <ul className="ml-10 list-disc">
          <li>Grafisk design for web</li>
          <li>UI/UX-design</li>
          <li>Frontend utvikling</li>
          <li>Backend utvikling</li>
          <li>Testing</li>
          <li>Serveradministrering (Ubuntu)</li>
        </ul>
      </div>

      <div className="m-3">
        {/*! TODO: FIX */}
        {/* biome-ignore lint/a11y/useAltText: Temporary ignore for ci/cd */}
        <img
          src="/images/teacher2.png"
          className="m-3 mx-auto mt-10 h-auto content-center sm:max-w-2xl"
        />
      </div>

      <div className="mt-10 ml-4 place-self-start font-sans text-black text-lg">
        Sjekk ut hva vi jobber med på{" "}
        <a
          href="https://github.com/vektorprogrammet"
          className="text-vektor-darblue hover:underline"
        >
          http://github.com/vektorprogrammet
        </a>
        !
      </div>
    </div>
  );
}
