import { Mail, Users } from "lucide-react";
import { useState } from "react";
import { NavLink as RouterNavLink, type To } from "react-router";
import { TabMenu } from "~/components/tab-menu";
import {
  type DepartmentContent,
  type TeamContent,
} from "~/lib/dev-content";
import type { DepartmentPretty } from "~/lib/types";

export type TeamLoaderData = {
  readonly teams: readonly TeamContent[];
  readonly departments: readonly DepartmentContent[];
};

export function TeamTabs({
  department,
  teams,
  departments: contentDepartments,
}: {
  department: DepartmentPretty;
  teams: readonly TeamContent[];
  departments: readonly DepartmentContent[];
}) {
  const [active, setActive] = useState<DepartmentPretty>(department);
  const tabs = contentDepartments.map((item) => item.name);

  return (
    <div
      className="mb-6 flex max-w-[256px] flex-col items-start sm:max-w-[544px] md:mb-auto md:max-w-6xl md:flex-row"
      role="tablist"
    >
      <div className="md:absolute md:left-3 lg:left-12">
        <TabMenu
          tabs={tabs}
          activeTab={active}
          setActiveTab={setActive}
        />
      </div>
      <div className="flex w-full max-w-5xl flex-col items-start">
        {active === "Hovedstyret" ? (
          <HovedstyretTab teams={teams} />
        ) : (
          <TeamTab team={active} teams={teams} />
        )}
      </div>
    </div>
  );
}

function HovedstyretTab({ teams }: { teams: readonly TeamContent[] }) {
  const team = teams.find((item) => item.city === "Hovedstyret");
  if (!team) return null;

  return (
    <div className="flex flex-col md:ml-24 md:max-w-2xl md:flex-row lg:ml-16 xl:ml-auto">
      <div className="flex-1 object-contain">
        <h2 className="font-bold text-2xl text-gray-600 sm:text-4xl dark:text-gray-200">
          {team.title}
        </h2>
        <p className="mt-4 mb-4 text-md sm:text-lg dark:text-gray-300">{team.text}</p>
        <div className="flex items-center space-x-1">
          <Mail className="h-5 w-5 text-black" />
          <a className="truncate text-sm hover:underline dark:text-white" href={`mailto:${team.email}`}>
            {team.email}
          </a>
        </div>
        <div className="mt-2 flex items-center space-x-1">
          <Users className="h-5 w-5 text-black" />
          <span>{`${team.numberOfMembers} medlemmer`}</span>
        </div>
        <br />
        <RouterNavLink
          to={team.url}
          className="rounded border border-blue-500 bg-transparent px-4 py-2 font-semibold text-blue-700 transition duration-300 hover:border-transparent hover:bg-blue-500 hover:text-white dark:bg-vektor-darkblue dark:text-white dark:hover:bg-blue-600"
          prefetch="intent"
        >
          Les mer
        </RouterNavLink>
      </div>
      <div className="mt-6 flex max-h-80 items-center justify-center md:col-span-1 md:mt-auto md:p-4">
        <img src={team.image} alt={team.imageAlt} className="max-h-80 object-contain" />
      </div>
    </div>
  );
}

function TeamTab({
  team,
  teams,
}: {
  team: Exclude<DepartmentPretty, "Hovedstyret">;
  teams: readonly TeamContent[];
}) {
  const cityTeams = teams.filter((item) => item.city === team);

  return (
    <div className="grid grid-cols-1 place-items-center gap-8 sm:grid-cols-2 xl:grid-cols-3">
      {cityTeams.map((item) => (
        <Division
          key={item.id}
          title={item.title}
          text={item.text}
          mail={item.email}
          numberOfMembers={item.numberOfMembers}
          buttonName="Les mer"
          url={item.url}
        />
      ))}
    </div>
  );
}

function Division({
  title,
  text,
  mail: _mail,
  numberOfMembers,
  buttonName,
  url,
}: {
  title: string;
  text: string;
  mail: string;
  numberOfMembers: number;
  buttonName: string;
  url: To;
}) {
  return (
    <RouterNavLink
      className="flex h-48 w-64 flex-col justify-between rounded-md bg-vektor-light-blue shadow-md dark:bg-gray-600 dark:text-white"
      to={url}
      prefetch="intent"
    >
      <div className="h-20 content-center rounded-t-md bg-vektor-blue dark:bg-vektor-darblue">
        <h3 className="text-center font-medium text-lg text-vektor-darblue dark:text-white">
          {title}
        </h3>
      </div>
      <div className="mx-3 my-2 h-full text-sm">
        <p>{text}</p>
      </div>
      <div className="mx-3 flex flex-row content-end gap-1 text-sm">
        <Users className="h-5 w-5 text-black" />
        <span>{`${numberOfMembers} medlemmer`}</span>
      </div>
      <div className="mr-1.5 mb-1.5 flex w-full justify-end self-end">
        <span className="inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap overflow-clip rounded-full bg-success px-3 text-sm font-medium text-white transition-colors hover:bg-vektor-green-hover">
          {buttonName}
        </span>
      </div>
    </RouterNavLink>
  );
}
