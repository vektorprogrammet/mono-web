import { Mail, MapPin, Users } from "lucide-react";
import { useState } from "react";
import { TabMenu } from "~/components/tab-menu";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import type { DepartmentContent } from "~/lib/dev-content";
import { type DepartmentPretty } from "~/lib/types";

export type DepartmentData = DepartmentContent;

export function ContactTabs({
  department,
  departments: contentDepartments,
}: {
  department: DepartmentPretty;
  departments: readonly DepartmentData[];
}) {
  const [active, setActive] = useState<DepartmentPretty>(department);
  const tabs = contentDepartments.map((item) => item.name);

  return (
    <div className="mb-6 flex w-full flex-col items-start md:mb-auto md:max-w-6xl lg:flex-row">
      <div className="mx-auto w-full px-5 sm:w-[440px] md:w-[400px] lg:absolute lg:left-10 lg:w-auto lg:px-0">
        <TabMenu
          className="w-full lg:w-auto"
          tabs={tabs}
          activeTab={active}
          setActiveTab={setActive}
        />
      </div>
      <main className="mx-auto mb-6 flex h-[500px] w-[calc(100%-1rem)] flex-col items-start overflow-y-scroll break-words rounded-md px-5 pt-0 pb-5 sm:w-[440px] md:w-[400px] lg:w-[480px] xl:w-[920px]">
        <div className="w-full flex-grow">
          <DepartmentCard department={active} departments={contentDepartments} />
        </div>
      </main>
    </div>
  );
}

function DepartmentCard({
  department,
  departments: contentDepartments,
}: {
  department: DepartmentPretty;
  departments: readonly DepartmentData[];
}) {
  const result = contentDepartments.find((item) => item.name === department);
  if (!result) return null;

  return (
    <>
      <div className="grid w-full grid-cols-1 gap-10 sm:p-6 lg:pt-0 xl:grid-cols-2">
        <div className="min-w-0">
          <h3 className="font-bold text-2xl text-blue-800 dark:text-neutral-200">
            {result.name}
          </h3>
          <div className="text-base">{result.description}</div>
          <div className="mt-3 flex items-center gap-1 md:mt-5">
            <Mail className="h-5 w-5 text-black" />
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(result.email);
              }}
              variant="link"
              className="h-auto justify-start p-0"
            >
              {result.email}
            </Button>
          </div>
          <div className="mt-2 flex gap-1 text-sm">
            <MapPin className="h-5 w-5 text-black" />
            <span>{result.address}</span>
          </div>
          <div className="flex gap-1 whitespace-nowrap text-sm">
            <Users className="h-5 w-5 text-black" />
            <span>{`${result.members} medlemmer`}</span>
          </div>
        </div>
        <div className="min-w-0 divide-y divide-solid">
          {result.contacts.map((contact) => (
            <div className="mb-3 md:mb-4" key={contact.name}>
              <div className="mt-1 text-blue-800 dark:text-gray-200">{contact.name}</div>
              <div className="my-2 flex flex-col items-start gap-1 md:my-3 md:flex-row md:items-center">
                {contact.title && <span className="whitespace-nowrap">{contact.title}</span>}
                <button
                  onClick={async () => {
                    await navigator.clipboard.writeText(contact.mail);
                  }}
                  className="break-all text-sm hover:underline md:text-base"
                  type="button"
                >
                  {contact.mail}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {result.openForContact && (
        <div className="mx-auto max-w-[600px] dark:bg-neutral-800">
          <div className="pt-10 text-center font-bold text-2xl text-blue-800 dark:text-gray-200">
            {`Kontakt styret i ${result.name}`}
          </div>
          <form>
            <div className="mt-7 mb-5 grid xl:grid-cols-2 xl:gap-6">
              <div className="mb-5 md:mb-0">
                <Label htmlFor="name">Ditt navn</Label>
                <Input placeholder="Skriv inn navn" required />
              </div>
              <div>
                <Label htmlFor="email">Din e-post</Label>
                <Input placeholder="Skriv inn epost" required />
              </div>
            </div>
            <div className="mb-5">
              <Label htmlFor="topic">Emne</Label>
              <Input placeholder="Skriv inn emnet for meldingen" required />
            </div>
            <div className="mb-5">
              <Label htmlFor="message">Melding</Label>
              <Textarea placeholder="Skriv inn meldingen din" rows={6} required id="message" />
            </div>
            <Button className="bg-vektor-darkblue hover:bg-vektor-blue">Send melding</Button>
          </form>
        </div>
      )}
    </>
  );
}
