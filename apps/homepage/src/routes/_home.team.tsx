import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Outlet } from "react-router";
import { getTeamFaqs } from "~/api/faq";
import { Divider } from "~/components/divider";
import type { TeamLoaderData } from "~/components/team-tabs";
import { DEV_CONTENT } from "~/lib/dev-content";

export function loader(): TeamLoaderData {
  return {
    teams: DEV_CONTENT.teams,
    departments: DEV_CONTENT.departments,
  };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Team({ loaderData }: { loaderData: TeamLoaderData }) {
  const teamFaqs = getTeamFaqs();
  return (
    <div className="mx-auto mt-20 mb-20 flex w-full max-w-6xl flex-col items-center">
      <header className="mx-auto flex w-full flex-wrap justify-around">
        <div className="mt-5 flex max-w-6xl flex-col">
          <h2 className="mx-3 font-bold text-4xl text-gray-600 dark:text-gray-200">
            Styre og team
          </h2>
          <div className="mx-3 mt-4 mb-20 max-w-md text-xl dark:text-gray-300">
            <span className="mb-4">
              Syntetiske teamprojeksjoner for lokal Worker-verifisering.
            </span>
            <div className="mt-6">
              <strong>Velg en region nedenfor.</strong>
            </div>
          </div>
        </div>
        <div className="relative mt-10">
          <img
            src="/images/teacher2.png"
            alt="Nøytral DEV CONTENT-teamillustrasjon"
            className="mx-auto mr-25 max-h-80 w-auto max-w-full object-contain"
          />
        </div>
      </header>
      <h1 className="mx-auto mt-10 mb-10 max-w-lg text-center font-bold text-5xl text-gray-600 dark:text-gray-200">
        Våre team
      </h1>
      <Outlet context={loaderData} />
      <Divider />
      <div className="flex w-4/5 max-w-4xl flex-col items-center gap-10 self-center md:mt-20 dark:text-text-dark">
        <h2 className="w-full text-center font-bold text-2xl text-vektor-DARKblue md:text-4xl dark:text-text-dark">
          Ofte stilte spørsmål
        </h2>
        <div className="flex w-full flex-col items-center">
          <Accordion type="single" collapsible className="w-full">
            {teamFaqs.map(({ question, answer }) => (
              <AccordionItem key={question} value={question}>
                <AccordionTrigger>
                  <p className="text-left">{question}</p>
                </AccordionTrigger>
                <AccordionContent>
                  <p className="text-left">{answer}</p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>
    </div>
  );
}
