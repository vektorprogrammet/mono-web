import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Form, Link, useLocation } from "react-router";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import type {
  PublicTeamApplicationActionData,
  PublicTeamApplicationErrorView,
  PublicTeamApplicationFailure,
  PublicTeamApplicationLoaderData,
  TeamApplicationFieldName,
  TeamApplicationFormRules,
  TeamApplicationTeam,
} from "~/lib/public-team-application";

type PublicTeamApplicationFormProps = {
  readonly loaderData: PublicTeamApplicationLoaderData;
  readonly actionData: PublicTeamApplicationActionData | undefined;
  readonly submitting: boolean;
};

type TeamApplicationConfirmation = Extract<
  PublicTeamApplicationActionData,
  { readonly outcome: "received" }
>["confirmation"];

const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

/** Keeps each control and its label on the same element id. */
function controlId(field: TeamApplicationFieldName): string {
  return `team-application-${field}`;
}

/** Keeps each field message and the control's aria-describedby on the same element id. */
function fieldErrorId(field: TeamApplicationFieldName): string {
  return `team-application-${field}-error`;
}

function FieldError({
  field,
  message,
}: {
  readonly field: TeamApplicationFieldName;
  readonly message: string | undefined;
}) {
  if (message === undefined) return null;

  return (
    <p id={fieldErrorId(field)} className="text-destructive text-sm">
      {message}
    </p>
  );
}

function ApplicationErrorAlert({ error }: { readonly error: PublicTeamApplicationErrorView }) {
  return (
    <div
      className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-foreground"
      data-error-tag={error._tag}
      role="alert"
    >
      <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold">Søknaden er ikke bekreftet</p>
        <p className="mt-1 text-sm">{error.message}</p>
      </div>
    </div>
  );
}

function Confirmation({ confirmation }: { readonly confirmation: TeamApplicationConfirmation }) {
  return (
    <Card
      className="overflow-hidden border-primary/20"
      data-team-application-confirmation={confirmation.applicationId}
    >
      <CardHeader className="border-b bg-primary text-primary-foreground">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="size-6 shrink-0" aria-hidden="true" />
          <h1 id="team-application-confirmation-title" className="font-semibold text-2xl">
            Søknaden er mottatt
          </h1>
        </div>
      </CardHeader>
      <CardContent
        className="space-y-4 pt-6"
        role="status"
        aria-labelledby="team-application-confirmation-title"
      >
        <p className="break-words">
          {confirmation.teamName === undefined
            ? "Søknaden din ble mottatt "
            : `Søknaden din til ${confirmation.teamName} ble mottatt `}
          <time dateTime={confirmation.submittedAt.at}>{confirmation.submittedAt.label}</time>.
        </p>
        <div className="rounded-md bg-muted p-4">
          <p className="text-foreground text-sm">Søknadsreferanse</p>
          <p className="mt-1 break-all font-mono font-semibold">{confirmation.applicationId}</p>
        </div>
        <p className="text-muted-foreground text-sm">
          Ta vare på referansen hvis du må kontakte oss om søknaden. Bekreftelsen viser ikke
          opplysningene du sendte inn.
        </p>
        <Button asChild variant="outline">
          <Link to="/team">Tilbake til teamene</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function IntakeClosed({
  team,
  message,
}: {
  readonly team: TeamApplicationTeam | undefined;
  readonly message: string | undefined;
}) {
  return (
    <Card data-team-application-intake="closed">
      <CardContent className="space-y-4 pt-6">
        <h1 className="font-semibold text-2xl">Teamet tar ikke imot søknader nå</h1>
        {message === undefined ? null : (
          <p className="rounded-md bg-muted p-4" role="alert">
            {message}
          </p>
        )}
        {team === undefined ? null : (
          <p className="break-words text-muted-foreground">
            {`${team.teamName} i ${team.departmentName} har ikke åpent for søknader akkurat nå.`}
          </p>
        )}
        <Button asChild variant="outline">
          <Link to="/team">Se alle teamene</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function TeamNotFound({ submitted }: { readonly submitted: boolean }) {
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <h1 className="font-semibold text-2xl">Fant ikke teamet</h1>
        {submitted ? (
          <p className="rounded-md bg-muted p-4" role="alert">
            Søknaden ble ikke lagret.
          </p>
        ) : null}
        <p className="text-muted-foreground">
          Teamet finnes ikke, eller det er ikke lenger aktivt. Du kan bare søke på aktive team.
        </p>
        <Button asChild variant="outline">
          <Link to="/team">Se alle teamene</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function IntakeUnavailable({ message }: { readonly message: string }) {
  const { pathname } = useLocation();

  return (
    <Card className="border-destructive/30">
      <CardContent className="space-y-4 pt-6" role="alert">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="font-semibold text-2xl">Søknadsskjemaet er ikke tilgjengelig</h1>
            <p className="mt-1 text-muted-foreground">{message}</p>
          </div>
        </div>
        <Button asChild variant="outline">
          <a href={pathname}>Prøv igjen</a>
        </Button>
      </CardContent>
    </Card>
  );
}

function ApplicationForm({
  team,
  rules,
  commandId,
  failure,
  submitting,
}: {
  readonly team: TeamApplicationTeam;
  readonly rules: TeamApplicationFormRules;
  readonly commandId: string;
  readonly failure: PublicTeamApplicationFailure | undefined;
  readonly submitting: boolean;
}) {
  const fieldErrors = failure?.error.fieldErrors;
  const fieldOfStudyHintId = "team-application-fieldOfStudy-hint";

  const control = (field: TeamApplicationFieldName, hintId?: string) => {
    const invalid = fieldErrors?.[field] !== undefined;

    const describedBy = [invalid ? fieldErrorId(field) : undefined, hintId]
      .filter((id) => id !== undefined)
      .join(" ");

    return {
      id: controlId(field),
      name: field,
      required: true,
      // A failed POST re-renders the page, so the draft comes back from the action.
      defaultValue: failure?.values[field] ?? "",
      "aria-invalid": invalid,
      "aria-describedby": describedBy === "" ? undefined : describedBy,
    };
  };

  return (
    <section aria-labelledby="team-application-title" data-team-application-intake="open">
      <Card className="overflow-hidden">
        <CardHeader className="space-y-3 border-b bg-primary text-primary-foreground">
          <p className="break-words font-semibold text-primary-foreground/80 text-sm uppercase tracking-wide">
            {team.departmentName}
          </p>
          <h1
            id="team-application-title"
            className="break-words font-semibold text-2xl md:text-3xl"
          >
            {`Søk på ${team.teamName}`}
          </h1>
          {team.deadline === null ? null : (
            <p className="text-primary-foreground/90">
              {"Søknadsfrist: "}
              <time dateTime={team.deadline.at}>{team.deadline.label}</time>
            </p>
          )}
        </CardHeader>

        <Form method="post" aria-busy={submitting}>
          {/* The server renders the key, so a POST without JavaScript carries it too. */}
          <input key={commandId} type="hidden" name="commandId" defaultValue={commandId} />

          <CardContent className="space-y-6 pt-6">
            {failure === undefined ? null : <ApplicationErrorAlert error={failure.error} />}
            <p className="text-muted-foreground text-sm">Alle feltene må fylles ut.</p>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="min-w-0 space-y-2">
                <Label htmlFor={controlId("name")}>Navn</Label>
                <Input {...control("name")} autoComplete="name" maxLength={rules.maxLength.name} />
                <FieldError field="name" message={fieldErrors?.name} />
              </div>

              <div className="min-w-0 space-y-2">
                <Label htmlFor={controlId("email")}>E-post</Label>
                <Input
                  {...control("email")}
                  type="email"
                  autoComplete="email"
                  maxLength={rules.maxLength.email}
                />
                <FieldError field="email" message={fieldErrors?.email} />
              </div>

              <div className="min-w-0 space-y-2">
                <Label htmlFor={controlId("phone")}>Telefon</Label>
                <Input
                  {...control("phone")}
                  type="tel"
                  autoComplete="tel"
                  maxLength={rules.maxLength.phone}
                />
                <FieldError field="phone" message={fieldErrors?.phone} />
              </div>

              <div className="min-w-0 space-y-2">
                <Label htmlFor={controlId("yearOfStudy")}>Årstrinn</Label>
                <select {...control("yearOfStudy")} className={selectClassName}>
                  <option value="">Velg årstrinn</option>
                  {rules.yearsOfStudy.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
                <FieldError field="yearOfStudy" message={fieldErrors?.yearOfStudy} />
              </div>
            </div>

            <div className="min-w-0 space-y-2">
              <Label htmlFor={controlId("fieldOfStudy")}>Linje</Label>
              <Input
                {...control("fieldOfStudy", fieldOfStudyHintId)}
                maxLength={rules.maxLength.fieldOfStudy}
              />
              <p id={fieldOfStudyHintId} className="text-muted-foreground text-sm">
                {`Høyst ${rules.maxLength.fieldOfStudy} tegn.`}
              </p>
              <FieldError field="fieldOfStudy" message={fieldErrors?.fieldOfStudy} />
            </div>

            <div className="min-w-0 space-y-2">
              <Label htmlFor={controlId("biography")}>Skriv litt om deg selv</Label>
              <Textarea {...control("biography")} rows={6} maxLength={rules.maxLength.biography} />
              <FieldError field="biography" message={fieldErrors?.biography} />
            </div>

            <div className="min-w-0 space-y-2">
              <Label htmlFor={controlId("motivation")}>
                Skriv kort om din motivasjon for vervet
              </Label>
              <Textarea
                {...control("motivation")}
                rows={6}
                maxLength={rules.maxLength.motivation}
              />
              <FieldError field="motivation" message={fieldErrors?.motivation} />
            </div>
          </CardContent>

          <CardFooter className="flex flex-col items-stretch gap-3 border-t bg-muted/40 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-sm" aria-live="polite">
              {submitting
                ? "Søknaden sendes …"
                : "Søknaden sendes først når du trykker på knappen."}
            </p>
            <Button type="submit" size="lg" disabled={submitting}>
              Send søknad
            </Button>
          </CardFooter>
        </Form>
      </Card>
    </section>
  );
}

export function PublicTeamApplicationForm({
  loaderData,
  actionData,
  submitting,
}: PublicTeamApplicationFormProps) {
  // A stored application outranks any later read of the team.
  if (actionData?.outcome === "received") {
    return <Confirmation confirmation={actionData.confirmation} />;
  }

  if (actionData?.outcome === "not-found" || loaderData.state === "not-found") {
    return <TeamNotFound submitted={actionData?.outcome === "not-found"} />;
  }

  if (actionData?.outcome === "closed" || loaderData.state === "closed") {
    return (
      <IntakeClosed
        team={"team" in loaderData ? loaderData.team : undefined}
        message={actionData?.outcome === "closed" ? actionData.message : undefined}
      />
    );
  }

  if (loaderData.state === "unavailable") {
    return <IntakeUnavailable message={loaderData.message} />;
  }

  const failure = actionData?.outcome === "rejected" ? actionData.failure : undefined;

  return (
    <ApplicationForm
      team={loaderData.team}
      rules={loaderData.rules}
      commandId={failure?.commandId ?? loaderData.commandId}
      failure={failure}
      submitting={submitting}
    />
  );
}
