import { Mail } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";
import type {
  TeamDirectory,
  TeamDirectoryDepartment,
  TeamDirectoryTeam,
} from "~/lib/team-directory";
import { cn } from "~/lib/utils";

const deadlineFormat = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Oslo",
});

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/** Department navigation and team cards; without a slug the first department is selected. */
export function TeamTabs({
  directory,
  selectedSlug,
}: {
  readonly directory: TeamDirectory;
  readonly selectedSlug?: string;
}) {
  const selected =
    selectedSlug === undefined
      ? directory.departments.at(0)
      : directory.departments.find((department) => department.slug === selectedSlug);

  return (
    <div className="mb-6 flex w-full flex-col gap-8 px-5 lg:flex-row">
      {directory.departments.length > 0 && (
        <nav aria-label="Velg avdeling" className="flex flex-wrap gap-2 lg:w-48 lg:shrink-0 lg:flex-col">
          {directory.departments.map((department) => {
            const current = department.departmentId === selected?.departmentId;

            return (
              <Link
                key={department.departmentId}
                to={`/team/${department.slug}`}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 max-w-full items-center justify-center rounded-full px-4 py-2 text-center font-medium text-sm transition-colors wrap-anywhere",
                  focusRing,
                  current
                    ? "bg-vektor-darkblue text-white"
                    : "text-black hover:bg-vektor-light-blue dark:text-white dark:hover:text-black",
                )}
              >
                {department.shortName}
              </Link>
            );
          })}
        </nav>
      )}
      <div className="w-full min-w-0">
        {selected !== undefined ? (
          <DepartmentTeams department={selected} intakeAvailable={directory.intakeAvailable} />
        ) : selectedSlug === undefined ? (
          <p role="status">Ingen team er publisert ennå.</p>
        ) : (
          <DepartmentNotFound />
        )}
      </div>
    </div>
  );
}

function DepartmentTeams({
  department,
  intakeAvailable,
}: {
  readonly department: TeamDirectoryDepartment;
  readonly intakeAvailable: boolean;
}) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-6">
      <h2
        id={headingId}
        className="font-bold text-2xl text-gray-600 wrap-anywhere dark:text-gray-200"
      >
        {department.name}
      </h2>
      {!intakeAvailable && (
        <p className="rounded-md bg-amber-100 p-3 text-amber-950" role="status">
          Søknadsstatus er midlertidig utilgjengelig. Prøv igjen senere.
        </p>
      )}
      {department.teams.length === 0 ? (
        <p role="status">Ingen team er publisert ennå.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {department.teams.map((team) => (
            <li key={team.teamId} className="min-w-0">
              <TeamCard team={team} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamCard({ team }: { readonly team: TeamDirectoryTeam }) {
  return (
    <article className="flex h-full min-h-48 flex-col rounded-md bg-vektor-light-blue shadow-md dark:bg-gray-600 dark:text-white">
      <div className="flex min-h-20 items-center justify-center rounded-t-md bg-vektor-blue px-3 py-2 dark:bg-vektor-darkblue">
        <h3 className="min-w-0 text-center font-medium text-lg text-vektor-darkblue wrap-anywhere dark:text-white">
          {team.name}
        </h3>
      </div>
      <div className="flex grow flex-col gap-3 p-3 text-sm">
        {team.shortDescription !== null && <p className="wrap-anywhere">{team.shortDescription}</p>}
        {team.email !== null && (
          <p className="flex items-start gap-2">
            <Mail aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <a className={cn("min-w-0 break-all hover:underline", focusRing)} href={`mailto:${team.email}`}>
              {team.email}
            </a>
          </p>
        )}
        {team.applyHref !== null && (
          <div className="mt-auto flex flex-col items-start gap-2 pt-2">
            {team.deadline !== null && (
              <p>
                {"Søknadsfrist: "}
                {/* Server and browser ICU data may format the same instant differently. */}
                <time dateTime={team.deadline} suppressHydrationWarning>
                  {deadlineFormat.format(new Date(team.deadline))}
                </time>
              </p>
            )}
            <Link
              to={team.applyHref}
              className={cn(
                "inline-flex min-h-10 max-w-full items-center rounded-full bg-vektor-green-hover px-4 py-2 font-medium text-sm text-white transition-colors wrap-anywhere hover:bg-vektor-darkblue",
                focusRing,
              )}
            >
              {`Søk på ${team.name}`}
            </Link>
          </div>
        )}
      </div>
    </article>
  );
}

function DepartmentNotFound() {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col items-start gap-4">
      <h2 id={headingId} className="font-bold text-2xl text-gray-600 dark:text-gray-200">
        Fant ikke avdelingen
      </h2>
      <p>Avdelingen finnes ikke eller er ikke aktiv.</p>
      <Link className={cn("font-medium underline", focusRing)} to="/team">
        Tilbake til teamoversikten
      </Link>
    </section>
  );
}
