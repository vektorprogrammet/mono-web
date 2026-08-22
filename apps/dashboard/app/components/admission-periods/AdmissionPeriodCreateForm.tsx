import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
  AdmissionPeriodCreateFailure,
  AdmissionPeriodMutationNotice,
} from "@/lib/admission-period-view";
import { Form, useNavigation } from "react-router";
import { ensureStableAdmissionPeriodCommandId } from "./admission-command-form";

type Props = {
  readonly failure?: AdmissionPeriodCreateFailure;
  readonly notice?: Extract<AdmissionPeriodMutationNotice, { intent: "create" }>;
  readonly semesterIds: ReadonlyArray<string>;
  readonly departmentIds: ReadonlyArray<string>;
};

const describedBy = (
  helpId: string,
  field: "semesterId" | "departmentId" | "startAt" | "endAt",
  failure?: AdmissionPeriodCreateFailure,
): string =>
  failure?.error.field === field ? `${helpId} admission-period-create-error` : helpId;

export function AdmissionPeriodCreateForm({
  failure,
  notice,
  semesterIds,
  departmentIds,
}: Props) {
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state !== "idle" && navigation.formData?.get("_intent") === "create";
  const draft = failure?.draft;

  return (
    <Form
      key={notice?.commandId ?? "new-admission-period"}
      method="post"
      onSubmit={ensureStableAdmissionPeriodCommandId}
      aria-labelledby="admission-period-create-title"
      aria-busy={isSubmitting}
    >
      <Card>
        <CardHeader>
          <h2 id="admission-period-create-title" className="font-semibold text-lg">
            Opprett opptaksperiode
          </h2>
          <p className="text-muted-foreground text-sm">
            Angi ett tidsrom innenfor semesteret. Avdeling og tilgang kontrolleres av API-et.
          </p>
        </CardHeader>

        <CardContent className="grid gap-5 sm:grid-cols-2">
          <input type="hidden" name="_intent" value="create" />
          <input type="hidden" name="commandId" value={failure?.commandId ?? ""} readOnly />

          {failure && (
            <p
              id="admission-period-create-error"
              className="border-destructive/40 bg-destructive/10 rounded-md border p-3 text-sm sm:col-span-2"
              role="alert"
              aria-atomic="true"
              data-error-tag={failure.error._tag}
              data-error-field={failure.error.field}
              data-command-id={failure.commandId}
            >
              {failure.error.message}
            </p>
          )}

          {notice && (
            <p
              className="rounded-md border bg-muted p-3 text-sm sm:col-span-2"
              role="status"
              aria-live="polite"
              data-command-id={notice.commandId}
            >
              Opptaksperioden er opprettet.
            </p>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="admission-period-semester">
              Semester-ID
              <span className="font-normal text-muted-foreground">(påkrevd)</span>
            </Label>
            <Input
              id="admission-period-semester"
              name="semesterId"
              list="admission-period-semesters"
              required
              autoComplete="off"
              defaultValue={draft?.semesterId}
              aria-invalid={failure?.error.field === "semesterId" || undefined}
              aria-describedby={describedBy(
                "admission-period-semester-help",
                "semesterId",
                failure,
              )}
            />
            <datalist id="admission-period-semesters">
              {semesterIds.map((semesterId) => (
                <option key={semesterId} value={semesterId} />
              ))}
            </datalist>
            <p id="admission-period-semester-help" className="text-muted-foreground text-xs">
              Skriv den stabile ID-en til semesteret.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="admission-period-department">Avdeling-ID</Label>
            <Input
              id="admission-period-department"
              name="departmentId"
              list="admission-period-departments"
              autoComplete="off"
              defaultValue={draft?.departmentId}
              aria-invalid={failure?.error.field === "departmentId" || undefined}
              aria-describedby={describedBy(
                "admission-period-department-help",
                "departmentId",
                failure,
              )}
            />
            <datalist id="admission-period-departments">
              {departmentIds.map((departmentId) => (
                <option key={departmentId} value={departmentId} />
              ))}
            </datalist>
            <p id="admission-period-department-help" className="text-muted-foreground text-xs">
              La feltet stå tomt som avdelingsleder. Global administrator må velge avdeling.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="admission-period-start">
              Starter (UTC)
              <span className="font-normal text-muted-foreground">(påkrevd)</span>
            </Label>
            <Input
              id="admission-period-start"
              name="startAt"
              type="datetime-local"
              step={60}
              required
              defaultValue={draft?.startAt}
              aria-invalid={failure?.error.field === "startAt" || undefined}
              aria-describedby={describedBy(
                "admission-period-start-help",
                "startAt",
                failure,
              )}
            />
            <p id="admission-period-start-help" className="text-muted-foreground text-xs">
              Tidspunktet tolkes og lagres som UTC.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="admission-period-end">
              Slutter (UTC)
              <span className="font-normal text-muted-foreground">(påkrevd)</span>
            </Label>
            <Input
              id="admission-period-end"
              name="endAt"
              type="datetime-local"
              step={60}
              required
              defaultValue={draft?.endAt}
              aria-invalid={failure?.error.field === "endAt" || undefined}
              aria-describedby={describedBy(
                "admission-period-end-help",
                "endAt",
                failure,
              )}
            />
            <p id="admission-period-end-help" className="text-muted-foreground text-xs">
              Slutt må være etter start og innenfor semesteret.
            </p>
          </div>
        </CardContent>

        <CardFooter className="justify-end">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Oppretter …" : "Opprett opptaksperiode"}
          </Button>
        </CardFooter>
      </Card>
    </Form>
  );
}
