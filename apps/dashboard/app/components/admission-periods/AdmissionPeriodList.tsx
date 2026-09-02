import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  AdmissionPeriodMutationNotice,
  AdmissionPeriodRevisionFailure,
  AdmissionPeriodUiError,
  AdmissionPeriodView,
} from "@/lib/admission-period-view";
import { AdmissionPeriodRow } from "./AdmissionPeriodRow";

type Props = {
  readonly periods: ReadonlyArray<AdmissionPeriodView>;
  readonly error?: AdmissionPeriodUiError;
  readonly failure?: AdmissionPeriodRevisionFailure;
  readonly notice?: Extract<AdmissionPeriodMutationNotice, { intent: "revise" }>;
  readonly busy: boolean;
};

export function AdmissionPeriodList({ periods, error, failure, notice, busy }: Props) {
  const actionErrorId = "admission-period-revision-error";

  return (
    <Card aria-labelledby="admission-period-list-title" aria-busy={busy}>
      <CardHeader>
        <h2 id="admission-period-list-title" className="font-semibold text-lg">
          Administrerte opptaksperioder
        </h2>
        <p className="text-muted-foreground text-sm">
          Listen viser bare avdelingene som den innloggede aktøren kan lese.
        </p>
      </CardHeader>

      <CardContent className="grid gap-4">
        {busy && (
          <p className="sr-only" role="status">
            Oppdaterer opptaksperiodene.
          </p>
        )}

        {error ? (
          <div
            className="border-destructive/40 bg-destructive/10 rounded-md border p-4"
            role="alert"
            aria-atomic="true"
            data-error-tag={error._tag}
          >
            <p className="font-medium">Kunne ikke hente opptaksperiodene.</p>
            <p className="mt-1 text-sm">{error.message}</p>
          </div>
        ) : (
          <>
            {failure && (
              <p
                id={actionErrorId}
                className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm"
                role="alert"
                aria-atomic="true"
                data-error-tag={failure.error._tag}
                data-error-field={failure.error.field}
                data-admission-period-id={failure.admissionPeriodId}
                data-etag={failure.etag}
                data-command-id={failure.commandId}
              >
                {failure.error.message}
              </p>
            )}

            {notice && (
              <p
                className="rounded-md border bg-muted p-3 text-sm"
                role="status"
                aria-live="polite"
                data-admission-period-id={notice.admissionPeriodId}
                data-command-id={notice.commandId}
                data-etag={notice.etag}
              >
                Opptaksperioden er lagret som en ny versjon.
              </p>
            )}

            {periods.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6">
                <p className="font-medium">Ingen opptaksperioder er opprettet.</p>
                <p className="mt-1 text-muted-foreground text-sm">
                  Bruk skjemaet over for å opprette den første perioden for et semester.
                </p>
              </div>
            ) : (
              <Table>
                <TableCaption className="sr-only">
                  Opptaksperioder med stabil ID, avdeling, semester, start, slutt, versjon og
                  tilgjengelige handlinger.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Semester og periode-ID</TableHead>
                    <TableHead scope="col">Avdeling</TableHead>
                    <TableHead scope="col">Starter</TableHead>
                    <TableHead scope="col">Slutter</TableHead>
                    <TableHead scope="col">Versjon</TableHead>
                    <TableHead scope="col" className="text-right">
                      Handlinger
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {periods.map((period) => (
                    <AdmissionPeriodRow
                      key={`${period.id}:${period.etag}`}
                      period={period}
                      failure={failure}
                      actionErrorId={actionErrorId}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
