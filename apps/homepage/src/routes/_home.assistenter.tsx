import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { getAssistenter } from "~/api/assistenter";
import { getAssistantFaqs } from "~/api/faq";
import { Divider } from "~/components/divider";
import { PublicApplicationForm } from "~/components/public-application-form";
import { Button } from "~/components/ui/button";
import { createPublicApplicationClient } from "~/lib/application-api.server";
import {
  mapPublicApplicationError,
  parsePublicApplicationForm,
  type PublicApplicationActionData,
  type PublicApplicationLoaderData,
} from "~/lib/public-application";
import type { Route } from "./+types/_home.assistenter";


export async function loader(): Promise<PublicApplicationLoaderData> {
  const client = createPublicApplicationClient();

  try {
    const catalog = await client.applications.catalog();
    return {
      ok: true,
      catalog: {
        departments: catalog.departments.map((department) => ({
          departmentId: department.departmentId,
          name: department.name,
          closesAt: department.closesAt,
          fieldsOfStudy: department.fieldsOfStudy.map((field) => ({
            fieldOfStudyId: field.fieldOfStudyId,
            name: field.name,
          })),
        })),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: mapPublicApplicationError(error),
    };
  }
}

export async function action({
  request,
}: Route.ActionArgs): Promise<PublicApplicationActionData> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    formData = new FormData();
  }

  const parsed = parsePublicApplicationForm(formData);
  if (!parsed.ok) {
    return {
      success: false,
      failure: {
        commandId: parsed.commandId,
        error: parsed.error,
      },
    };
  }

  const client = createPublicApplicationClient();
  try {
    const submitted = await client.applications.submit(parsed.value);
    const confirmation = await client.applications.confirmation(
      submitted.applicationId,
    );
    if (confirmation.applicationId !== submitted.applicationId) {
      return {
        success: false,
        failure: {
          commandId: parsed.value.commandId,
          error: {
            _tag: "Unexpected",
            message: "Søknaden kunne ikke bekreftes. Prøv igjen senere.",
          },
        },
      };
    }

    return {
      success: true,
      confirmation: {
        _tag: "ApplicationConfirmed",
        applicationId: confirmation.applicationId,
      },
    };
  } catch (error) {
    return {
      success: false,
      failure: {
        commandId: parsed.value.commandId,
        error: mapPublicApplicationError(error),
      },
    };
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Assistenter() {
  const { title, ingress, cards } = getAssistenter();
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const openDepartmentNames = loaderData.ok
    ? loaderData.catalog.departments.map((department) => department.name)
    : [];


  const assistantFaqs = getAssistantFaqs();

  return (
    <div className="mt-20 mb-20 flex w-full flex-col items-center gap-10 self-center pt-5 pb-5 font-sans leading-relaxed dark:text-text-dark">
      <div className="flex max-w-full flex-col gap-3 md:gap-5">
        <h1 className="max-w-3xl text-center font-bold text-2xl text-vektor-DARKblue md:text-4xl dark:text-text-dark">
          {title}
        </h1>
        <p className="max-w-3xl p-5 text-md md:text-lg">{ingress}</p>
        <div className="w-full space-y-6 border-secondary p-10 text-center">
          <p className="mx-8 font-bold font-sans text-vektor-DARKblue dark:text-text-dark">
            {openDepartmentNames.length > 0
              ? `Opptaket er åpent i ${openDepartmentNames.join(", ")}.`
              : "Se gjeldende opptak og frister i søknadsdelen."}
          </p>
          <Button variant="green" asChild>
            <a href="#sok">Gå til søknadsskjema</a>
          </Button>
        </div>
      </div>
      {/* upper end */}
      {/* middle start */}
      <div className="info-background mb-0 flex w-full max-w-full flex-col flex-wrap items-center justify-center gap-24 pt-96 pb-96 text-center md:mt-20 md:gap-40 md:pt-72 md:pb-72">
        <div className="w-fit font-bold text-3xl text-accent">
          {"Hvorfor bli assistent?"}
        </div>
        <div className="info-background flex w-full flex-wrap items-center justify-center gap-10 text-center md:flex-row">
          {cards.map(({ title, text, image }) => (
            <div
              key={title}
              className="flex w-full max-w-xs flex-col gap-5 text-vektor-bg md:w-1/3"
            >
              <div>
                <img
                  src={image.url}
                  alt={image.alt}
                  className="mx-auto mt-6 mb-2 h-24 rounded-lg"
                />
                <div className="p-1 text-center font-bold font-sans text-secondary text-xl">
                  {title}
                </div>
                <div className="my-1 text-center font-sans dark:text-text-dark">
                  {text}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* middle end */}
      <div className="mb-16 flex flex-col items-center dark:text-text-dark">
        <div className="my-2 mb-2 w-fit font-bold text-2xl text-vektor-DARKblue dark:text-text-dark">
          {"Lærerassistent i matematikk"}
        </div>
        <div className="max-w-3xl p-5 text-md md:text-lg dark:text-text-dark">
          {`Vektorprogrammet er en studentorganisasjon som sender realfagssterke
          studenter til grunnskolen for å hjelpe elevene med matematikk i
          skoletiden. Vi ser etter deg som lengter etter en mulighet til å lære
          bort kunnskapene du sitter med og ønsker å ta del i et sterkt sosialt
          fellesskap. Etter å ha vært vektorassistent kommer du til å sitte
          igjen med mange gode erfaringer og nye venner på tvers av trinn og
          linje.`}
        </div>

        <img
          src="/images/teacher2.png"
          className="mx-auto mt-6 h-80 rounded-lg"
          alt="vektorbilde"
        />
        <div className="max-w-3xl p-5 text-md md:text-lg dark:text-text-dark">
          {`I tillegg vil du få muligheten til å delta på mange sosiale
          arrangementer, alt fra fest og grilling til go-kart, laser tag og
          spillkvelder. Samtidig arrangerer vi populærforedrag som er til for å
          øke motivasjonen din for videre studier. Vi har hatt besøk av blant
          annet Andreas Wahl, Jo Røislien, Knut Jørgen Røed Ødegaard og James
          Grime.`}
        </div>
      </div>
      <Divider />
      <div className="mb-16 flex flex-col items-center dark:text-text-dark">
        <div className="my-2 mb-3 text-center font-bold text-2xl text-vektor-darblue dark:text-text-dark">
          {"Arbeidsoppgaver"}
        </div>

        <div className="max-w-3xl p-5 text-md md:text-lg">
          {`Som vektorassistent er du ute én dag i uka, i 4 eller 8 uker, på en
          ungdomsskole i nærområdet. Vi tilpasser timeplanen slik at du selv kan
          bestemme hvilken dag som passer best. Vektorassistenter blir sendt ut
          i par, slik at du alltid kan ha noen å støtte deg på. Oppgavene dine
          vil variere fra å gå rundt i klasserommet og hjelpe elever med
          oppgaver, til å gjennomgå utvalgte temaer i mindre grupper. Det er
          læreren som bestemmer hva som skal bli gjennomgått. Dette arbeidet
          blir satt stor pris på av både barn og lærere!`}
        </div>
      </div>
      <Divider />
      <div className="mx-auto w-4/5">
        <div className="my-8 text-center font-bold text-2xl text-vektor-DARKblue dark:text-text-dark">
          {"Hvordan blir jeg Vektorassistent?"}
        </div>

        <div className="flex flex-col space-y-8 md:flex-row md:space-x-16 md:space-y-0 dark:text-text-dark">
          {/* Left section */}
          <div className="flex-1">
            <ul className="list-disc whitespace-normal px-4 leading-loose md:px-0">
              <div className="my-3 font-bold text-lg text-vektor-darblue dark:text-text-dark">
                {"Opptakskrav"}
              </div>

              <li>{"Du studerer på høgskole/universitet"}</li>
              <li>{"Du har hatt R1/S2 på videregående"}</li>
              <li>
                {
                  "Du har tid til å dra til en ungdomsskole én dag i uka (kl. 8-14)"
                }
                <br />
                {"i en periode på 4 eller 8 uker"}
              </li>
            </ul>
          </div>

          {/* Right section */}
          <div className="flex-1">
            <div className="my-3 font-bold text-lg text-vektor-DARKblue dark:text-text-dark">
              {"Opptaksprosessen"}
            </div>
            <ol className="list-decimal whitespace-normal px-4 leading-loose md:px-0">
              <li>
                {
                  "Vektorprogrammet tar opp nye assistenter i starten av hvert semester"
                }
              </li>
              <li>
                {"Send inn søknad fra skjemaet lengre ned på denne siden"}
              </li>
              <li>
                {"Møt opp på intervju slik at vi kan bli bedre kjent med deg"}
              </li>
              <li>
                {
                  "Dra på et gratis forberedelseskurs arrangert av Vektorprogrammet"
                }
              </li>
              <li>
                {
                  "Få tildelt en ungdomsskole som du og din vektorpartner skal dra til"
                }
              </li>
            </ol>
          </div>
        </div>
      </div>
      <PublicApplicationForm
        loaderData={loaderData}
        actionData={actionData}
        submitting={navigation.state === "submitting"}
      />
      <Divider />

      {/* FAQ Section */}
      <div className="flex w-4/5 max-w-4xl flex-col items-center gap-10 self-center dark:text-text-dark">
        <h2 className="w-full text-center font-bold text-2xl text-vektor-DARKblue md:text-4xl dark:text-text-dark">
          {"Ofte stilte spørsmål"}
        </h2>

        <div className="flex w-full flex-col items-center">
          <Accordion type="single" collapsible className="w-full">
            {assistantFaqs.map(({ question, answer }) => (
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
