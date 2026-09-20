import type {
  ApplicantProgressItem,
  ApplicantProgressResponse,
  ApplicantProgressState,
} from "@vektorprogrammet/domain/application";
import { data, useLoaderData } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import { nativeProblemFrom } from "../lib/native-problem";
import type { Route } from "./+types/dashboard.soknad._index";

const responseHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
} as const;

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  try {
    const response = await client.admissions.readApplicantProgress();
    return data(
      { progress: response.body as ApplicantProgressResponse, unavailable: false as const },
      { headers: responseHeaders },
    );
  } catch (cause) {
    const problem = nativeProblemFrom(cause);
    if (problem?.code === "credential.missing" || problem?.code === "credential.invalid") {
      throw await expiredSessionRedirect(request);
    }
    return data(
      { progress: null, unavailable: true as const },
      { status: 503, headers: responseHeaders },
    );
  }
}

const steps = [
  "Søknad mottatt",
  "Invitert til intervju",
  "Intervju avtalt",
  "Intervju fullført",
  "Tatt opp som vektorassistent",
] as const;

const statePresentation: Record<
  ApplicantProgressState["_tag"],
  {
    readonly title: string;
    readonly next: string;
    readonly step: number;
    readonly cancelled?: true;
  }
> = {
  ApplicationReceived: {
    title: "Søknaden er mottatt",
    next: "Vent på invitasjon til intervju.",
    step: 0,
  },
  InvitedToInterview: {
    title: "Du er invitert til intervju",
    next: "Svar på invitasjonen fra lenken du har mottatt.",
    step: 1,
  },
  InterviewAccepted: {
    title: "Intervjuet er avtalt",
    next: "Møt opp til avtalt tid og sted.",
    step: 2,
  },
  AwaitingNewInterviewTime: {
    title: "Du har bedt om et nytt intervjutidspunkt",
    next: "Vent på en ny invitasjon. Det gamle tidspunktet gjelder ikke.",
    step: 1,
  },
  Cancelled: {
    title: "Rekrutteringsløpet er avsluttet",
    next: "Det er ingen flere handlinger i dette rekrutteringsløpet.",
    step: 0,
    cancelled: true,
  },
  InterviewCompleted: {
    title: "Intervjuet er fullført",
    next: "Søknaden vurderes. Du får svar separat.",
    step: 3,
  },
  AssignedToSchool: {
    title: "Du er tatt opp som vektorassistent",
    next: "Følg informasjonen fra kontaktpersonene ved skolen.",
    step: 4,
  },
};

const dateTimeFormatter = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Oslo",
});

function Schedule({ progress }: { readonly progress: ApplicantProgressState }) {
  if (progress._tag !== "InvitedToInterview" && progress._tag !== "InterviewAccepted") {
    return null;
  }
  const { schedule } = progress;
  return (
    <dl className="mt-4 grid gap-2 rounded-md border bg-muted/30 p-4 sm:grid-cols-2">
      <div>
        <dt className="text-sm font-medium text-muted-foreground">Tid</dt>
        <dd>
          <time dateTime={schedule.scheduledAt}>
            {dateTimeFormatter.format(new Date(schedule.scheduledAt))}
          </time>
        </dd>
      </div>
      <div>
        <dt className="text-sm font-medium text-muted-foreground">Rom</dt>
        <dd>{schedule.room}</dd>
      </div>
      {schedule.campus === null ? null : (
        <div>
          <dt className="text-sm font-medium text-muted-foreground">Campus</dt>
          <dd>{schedule.campus}</dd>
        </div>
      )}
      {schedule.mapLink === null ? null : (
        <div>
          <dt className="text-sm font-medium text-muted-foreground">Kart</dt>
          <dd>
            <a className="underline underline-offset-4" href={schedule.mapLink} rel="noreferrer">
              Åpne kart
            </a>
          </dd>
        </div>
      )}
    </dl>
  );
}

function ProgressSteps({ progress }: { readonly progress: ApplicantProgressState }) {
  const presentation = statePresentation[progress._tag];
  return (
    <ol aria-label="Søknadsprosess" className="mt-6 grid gap-3 md:grid-cols-5">
      {steps.map((label, index) => {
        const completed = !presentation.cancelled && index < presentation.step;
        const current = index === presentation.step;
        return (
          <li
            key={label}
            aria-current={current ? "step" : undefined}
            className="rounded-md border p-3"
          >
            <span className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Steg {index + 1}
            </span>
            <span className="mt-1 block font-medium">{label}</span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {completed
                ? "Fullført"
                : current
                  ? presentation.cancelled
                    ? "Avsluttet"
                    : "Nå"
                  : "Senere"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ApplicationCard({ application }: { readonly application: ApplicantProgressItem }) {
  const presentation = statePresentation[application.progress._tag];
  return (
    <article
      className="rounded-lg border bg-card p-5 shadow-sm"
      aria-labelledby={`status-${application.applicationId}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Avdeling {application.departmentId}</p>
          <h2 id={`status-${application.applicationId}`} className="text-xl font-semibold">
            {presentation.title}
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">
          Sendt{" "}
          <time dateTime={application.submittedAt}>
            {dateTimeFormatter.format(new Date(application.submittedAt))}
          </time>
        </p>
      </div>
      <p role="status" className="mt-3 font-medium">
        Neste: {presentation.next}
      </p>
      <Schedule progress={application.progress} />
      <ProgressSteps progress={application.progress} />
    </article>
  );
}

export default function ApplicantProgressPage() {
  const result = useLoaderData<typeof loader>();
  if (result.unavailable) {
    return (
      <main className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <h1 className="text-2xl font-semibold">Min søknad</h1>
        <p role="alert" className="mt-4 rounded-md border p-4">
          Søknadsstatusen kunne ikke lastes. Prøv igjen senere.
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <h1 className="text-2xl font-semibold">Min søknad</h1>
      <p className="mt-2 text-muted-foreground">
        Her ser du status og neste steg for søknader i inneværende semester.
      </p>
      {result.progress.applications.length === 0 ? (
        <p role="status" className="mt-6 rounded-md border p-5">
          Du har ingen aktive søknader som er koblet til denne kontoen.
        </p>
      ) : (
        <div className="mt-6 space-y-5">
          {result.progress.applications.map((application) => (
            <ApplicationCard key={application.applicationId} application={application} />
          ))}
        </div>
      )}
    </main>
  );
}
