import { AlertCircle, CheckCircle2, ShieldCheck } from "lucide-react";
import {
  type FormEvent,
  type SelectHTMLAttributes,
  useState,
} from "react";
import { Form, useSubmit } from "react-router";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type {
  ApplicantFieldName,
  PublicApplicationActionData,
  PublicApplicationErrorView,
  PublicApplicationLoaderData,
} from "~/lib/public-application";
import { cn } from "~/lib/utils";

type PublicApplicationFormProps = {
  readonly loaderData: PublicApplicationLoaderData;
  readonly actionData: PublicApplicationActionData | undefined;
  readonly submitting: boolean;
};

const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm";

function NativeSelect({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(selectClassName, className)} {...props} />;
}

function FieldError({
  field,
  error,
}: {
  readonly field: ApplicantFieldName;
  readonly error: PublicApplicationErrorView | undefined;
}) {
  const message = error?.fieldErrors?.[field];
  if (!message) return null;

  return (
    <p id={`${field}-error`} className="text-destructive text-sm">
      {message}
    </p>
  );
}

function errorDescription(
  field: ApplicantFieldName,
  error: PublicApplicationErrorView | undefined,
  extraId?: string,
): string | undefined {
  const ids = [error?.fieldErrors?.[field] ? `${field}-error` : undefined, extraId]
    .filter((id): id is string => id !== undefined)
    .join(" ");
  return ids || undefined;
}

function ApplicationErrorAlert({
  error,
}: {
  readonly error: PublicApplicationErrorView;
}) {
  return (
    <div
      className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-foreground"
      data-error-tag={error._tag}
      role="alert"
    >
      <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
      <div>
        <p className="font-semibold">Søknaden ble ikke sendt</p>
        <p className="mt-1 text-sm">{error.message}</p>
      </div>
    </div>
  );
}

function Confirmation({
  applicationId,
}: {
  readonly applicationId: string;
}) {
  return (
    <Card
      className="overflow-hidden border-primary/20"
      data-application-confirmation={applicationId}
    >
      <CardHeader className="border-b bg-primary text-primary-foreground">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="size-6 shrink-0" aria-hidden="true" />
          <h2 id="application-confirmation-title" className="font-semibold text-2xl">
            Søknaden er mottatt
          </h2>
        </div>
      </CardHeader>
      <CardContent
        className="space-y-4 pt-6"
        role="status"
        aria-labelledby="application-confirmation-title"
      >
        <p>
          Takk for søknaden. Ta vare på referansen hvis du må kontakte oss om
          innsendingen.
        </p>
        <div className="rounded-md bg-muted p-4">
          <p className="text-muted-foreground text-sm">Søknadsreferanse</p>
          <p className="mt-1 break-all font-mono font-semibold" data-testid="application-id">
            {applicationId}
          </p>
        </div>
        <p className="text-muted-foreground text-sm">
          Bekreftelsen viser ikke personopplysningene du sendte inn.
        </p>
      </CardContent>
    </Card>
  );
}

function CatalogUnavailable({
  error,
}: {
  readonly error: PublicApplicationErrorView;
}) {
  return (
    <Card className="border-destructive/30">
      <CardContent className="space-y-4 pt-6" role="alert" data-error-tag={error._tag}>
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <h2 className="font-semibold text-xl">Vi kunne ikke hente åpne opptak</h2>
            <p className="mt-1 text-muted-foreground">{error.message}</p>
          </div>
        </div>
        <Button asChild variant="outline">
          <a href="/assistenter#sok">Prøv igjen</a>
        </Button>
      </CardContent>
    </Card>
  );
}

function EmptyCatalog() {
  return (
    <Card>
      <CardContent className="space-y-2 pt-6" role="status">
        <h2 className="font-semibold text-xl">Ingen opptak er åpne nå</h2>
        <p className="text-muted-foreground">
          Nye opptak vises her når en avdeling åpner en søknadsperiode. Kom
          tilbake senere for å se oppdaterte frister.
        </p>
      </CardContent>
    </Card>
  );
}

export function PublicApplicationForm({
  loaderData,
  actionData,
  submitting,
}: PublicApplicationFormProps) {
  const submit = useSubmit();
  const [departmentId, setDepartmentId] = useState("");
  const [fieldOfStudyId, setFieldOfStudyId] = useState("");

  if (actionData?.success === true) {
    return (
      <section
        id="sok"
        className="w-full scroll-mt-24 px-4 sm:px-6"
        aria-labelledby="application-confirmation-title"
      >
        <div className="mx-auto max-w-3xl">
          <Confirmation applicationId={actionData.confirmation.applicationId} />
        </div>
      </section>
    );
  }

  if (!loaderData.ok) {
    return (
      <section id="sok" className="w-full scroll-mt-24 px-4 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <CatalogUnavailable error={loaderData.error} />
        </div>
      </section>
    );
  }

  if (loaderData.catalog.departments.length === 0) {
    return (
      <section id="sok" className="w-full scroll-mt-24 px-4 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <EmptyCatalog />
        </div>
      </section>
    );
  }

  const selectedDepartment = loaderData.catalog.departments.find(
    (department) => department.departmentId === departmentId,
  );
  const submissionError =
    actionData?.success === false ? actionData.failure.error : undefined;
  const commandIdKey = submissionError?.resetCommandId
    ? `reset-${actionData?.success === false ? actionData.failure.commandId : ""}`
    : "stable-command";
  const commandIdDefault = submissionError?.resetCommandId
    ? ""
    : actionData?.success === false
      ? actionData.failure.commandId
      : "";

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const commandIdInput = event.currentTarget.elements.namedItem("commandId");
    if (!(commandIdInput instanceof HTMLInputElement)) return;
    if (commandIdInput.value === "") {
      commandIdInput.value = globalThis.crypto.randomUUID();
    }
    void submit(event.currentTarget, { method: "post" });
  };

  const deadline = selectedDepartment
    ? new Intl.DateTimeFormat("nb-NO", {
        dateStyle: "long",
        timeStyle: "short",
        timeZone: "Europe/Oslo",
      }).format(new Date(selectedDepartment.closesAt))
    : undefined;

  return (
    <section
      id="sok"
      className="w-full scroll-mt-24 px-4 sm:px-6"
      aria-labelledby="public-application-title"
    >
      <Card className="mx-auto max-w-3xl overflow-hidden">
        <CardHeader className="space-y-3 border-b bg-primary text-primary-foreground">
          <p className="font-semibold text-primary-foreground/80 text-sm uppercase tracking-wide">
            Vektorassistent
          </p>
          <h2 id="public-application-title" className="font-semibold text-2xl md:text-3xl">
            Send inn søknad
          </h2>
          <p className="max-w-2xl text-primary-foreground/90">
            Velg et åpent opptak og fyll ut alle feltene. Søknaden sendes først
            når du trykker på knappen nederst.
          </p>
        </CardHeader>

        <Form
          method="post"
          onSubmit={handleSubmit}
          aria-busy={submitting}
          aria-describedby="application-privacy"
        >
          <input
            key={commandIdKey}
            type="hidden"
            name="commandId"
            defaultValue={commandIdDefault}
          />

          <CardContent className="space-y-8 pt-6">
            {submissionError ? <ApplicationErrorAlert error={submissionError} /> : null}

            <fieldset className="space-y-5">
              <legend className="font-semibold text-lg">Opptak og studier</legend>
              <p className="text-muted-foreground text-sm">
                Studieretningene kommer fra valgt avdeling. Alle felt er
                obligatoriske.
              </p>

              <div className="space-y-2">
                <Label htmlFor="departmentId">Avdeling</Label>
                <NativeSelect
                  id="departmentId"
                  name="departmentId"
                  value={departmentId}
                  required
                  disabled={submitting}
                  aria-invalid={Boolean(submissionError?.fieldErrors?.departmentId)}
                  aria-describedby={errorDescription("departmentId", submissionError)}
                  onChange={(event) => {
                    setDepartmentId(event.target.value);
                    setFieldOfStudyId("");
                  }}
                >
                  <option value="">Velg avdeling</option>
                  {loaderData.catalog.departments.map((department) => (
                    <option key={department.departmentId} value={department.departmentId}>
                      {department.name}
                    </option>
                  ))}
                </NativeSelect>
                <FieldError field="departmentId" error={submissionError} />
                {selectedDepartment && deadline ? (
                  <p className="text-muted-foreground text-sm">
                    Søknadsfrist: {" "}
                    <time dateTime={selectedDepartment.closesAt}>{deadline}</time>
                  </p>
                ) : null}
              </div>

              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="fieldOfStudyId">Studieretning</Label>
                  <NativeSelect
                    id="fieldOfStudyId"
                    name="fieldOfStudyId"
                    value={fieldOfStudyId}
                    required
                    disabled={!selectedDepartment || submitting}
                    aria-invalid={Boolean(submissionError?.fieldErrors?.fieldOfStudyId)}
                    aria-describedby={errorDescription("fieldOfStudyId", submissionError)}
                    onChange={(event) => setFieldOfStudyId(event.target.value)}
                  >
                    <option value="">
                      {selectedDepartment
                        ? "Velg studieretning"
                        : "Velg avdeling først"}
                    </option>
                    {selectedDepartment?.fieldsOfStudy.map((field) => (
                      <option key={field.fieldOfStudyId} value={field.fieldOfStudyId}>
                        {field.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <FieldError field="fieldOfStudyId" error={submissionError} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="yearOfStudy">Studieår</Label>
                  <NativeSelect
                    id="yearOfStudy"
                    name="yearOfStudy"
                    defaultValue=""
                    required
                    disabled={submitting}
                    aria-invalid={Boolean(submissionError?.fieldErrors?.yearOfStudy)}
                    aria-describedby={errorDescription("yearOfStudy", submissionError)}
                  >
                    <option value="">Velg studieår</option>
                    {[1, 2, 3, 4, 5].map((year) => (
                      <option key={year} value={year}>
                        {year}. studieår
                      </option>
                    ))}
                  </NativeSelect>
                  <FieldError field="yearOfStudy" error={submissionError} />
                </div>
              </div>
            </fieldset>

            <div className="border-t" />

            <fieldset className="space-y-5">
              <legend className="font-semibold text-lg">Kontaktinformasjon</legend>
              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="firstName">Fornavn</Label>
                  <Input
                    id="firstName"
                    name="firstName"
                    autoComplete="given-name"
                    maxLength={100}
                    required
                    disabled={submitting}
                    aria-invalid={Boolean(submissionError?.fieldErrors?.firstName)}
                    aria-describedby={errorDescription("firstName", submissionError)}
                  />
                  <FieldError field="firstName" error={submissionError} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="lastName">Etternavn</Label>
                  <Input
                    id="lastName"
                    name="lastName"
                    autoComplete="family-name"
                    maxLength={100}
                    required
                    disabled={submitting}
                    aria-invalid={Boolean(submissionError?.fieldErrors?.lastName)}
                    aria-describedby={errorDescription("lastName", submissionError)}
                  />
                  <FieldError field="lastName" error={submissionError} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">E-post</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    required
                    disabled={submitting}
                    aria-invalid={Boolean(submissionError?.fieldErrors?.email)}
                    aria-describedby={errorDescription("email", submissionError)}
                  />
                  <FieldError field="email" error={submissionError} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="phone">Telefonnummer</Label>
                  <Input
                    id="phone"
                    name="phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    maxLength={32}
                    required
                    disabled={submitting}
                    aria-invalid={Boolean(submissionError?.fieldErrors?.phone)}
                    aria-describedby={errorDescription("phone", submissionError)}
                  />
                  <FieldError field="phone" error={submissionError} />
                </div>

                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="gender">Kjønn</Label>
                  <NativeSelect
                    id="gender"
                    name="gender"
                    defaultValue=""
                    required
                    disabled={submitting}
                    aria-invalid={Boolean(submissionError?.fieldErrors?.gender)}
                    aria-describedby={errorDescription("gender", submissionError)}
                  >
                    <option value="">Velg kjønn</option>
                    <option value="0">Mann</option>
                    <option value="1">Kvinne</option>
                  </NativeSelect>
                  <FieldError field="gender" error={submissionError} />
                </div>
              </div>
            </fieldset>

            <aside
              id="application-privacy"
              className="flex gap-3 rounded-md bg-muted p-4 text-sm"
            >
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
              <p>
                Opplysningene brukes til å behandle søknaden. Bekreftelsen viser
                bare en søknadsreferanse og gjentar ikke kontaktopplysningene dine.
              </p>
            </aside>
          </CardContent>

          <CardFooter className="flex flex-col items-stretch gap-3 border-t bg-muted/40 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground text-sm" aria-live="polite">
              {submitting ? "Søknaden sendes sikkert …" : "Kontroller opplysningene før du sender."}
            </p>
            <Button type="submit" size="lg" disabled={submitting}>
              {submitting ? "Sender søknad …" : "Send søknad"}
            </Button>
          </CardFooter>
        </Form>
      </Card>
    </section>
  );
}
