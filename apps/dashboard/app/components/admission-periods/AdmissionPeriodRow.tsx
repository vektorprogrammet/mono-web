import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableCell, TableRow } from "@/components/ui/table";
import type {
  AdmissionPeriodRevisionFailure,
  AdmissionPeriodUiErrorField,
  AdmissionPeriodView,
} from "@/lib/admission-period-view";
import { Fragment, useId, useState } from "react";
import { Form, useNavigation } from "react-router";
import { ensureStableAdmissionPeriodCommandId } from "./admission-command-form";

type Props = {
  readonly period: AdmissionPeriodView;
  readonly failure?: AdmissionPeriodRevisionFailure;
  readonly actionErrorId: string;
};

const fieldDescription = (
  helpId: string,
  field: AdmissionPeriodUiErrorField,
  errorId: string,
  failure?: AdmissionPeriodRevisionFailure,
): string => (failure?.error.field === field ? `${helpId} ${errorId}` : helpId);

export function AdmissionPeriodRow({ period, failure, actionErrorId }: Props) {
  const relevantFailure =
    failure?.admissionPeriodId === period.id && failure.etag === period.etag ? failure : undefined;
  const [editing, setEditing] = useState(relevantFailure !== undefined);
  const [commandId, setCommandId] = useState(relevantFailure?.commandId ?? "");
  const fieldId = useId();
  const panelId = `${fieldId}-revision-panel`;
  const titleId = `${fieldId}-revision-title`;
  const navigation = useNavigation();
  const revising =
    navigation.state !== "idle" &&
    navigation.formData?.get("_intent") === "revise" &&
    navigation.formData?.get("admissionPeriodId") === period.id;
  const draft = relevantFailure?.draft;

  return (
    <Fragment>
      <TableRow
        data-admission-period-id={period.id}
        data-department-id={period.departmentId}
        data-semester-id={period.semesterId}
        data-revision={period.revision}
        data-etag={period.etag}
      >
        <TableCell>
          <div className="flex flex-col gap-1">
            <span className="font-medium">{period.semesterId}</span>
            <code className="break-all font-mono text-muted-foreground text-xs">{period.id}</code>
          </div>
        </TableCell>
        <TableCell>
          <code className="break-all font-mono text-xs">{period.departmentId}</code>
        </TableCell>
        <TableCell>
          <time dateTime={period.startAt}>{period.startAtLabel}</time>
        </TableCell>
        <TableCell>
          <time dateTime={period.endAt}>{period.endAtLabel}</time>
        </TableCell>
        <TableCell>
          <span data-testid="admission-period-revision">Versjon {period.revision}</span>
        </TableCell>
        <TableCell className="text-right">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={editing}
            aria-controls={panelId}
            disabled={revising}
            onClick={() => {
              if (!editing && commandId.length === 0) {
                setCommandId(crypto.randomUUID());
              }
              setEditing((current) => !current);
            }}
          >
            {editing ? "Lukk redigering" : "Revider"}
          </Button>
        </TableCell>
      </TableRow>

      <TableRow id={panelId} hidden={!editing} data-admission-period-revision-panel>
        <TableCell colSpan={6} className="bg-muted/30 p-4 whitespace-normal sm:p-6">
          <Form
            method="post"
            onSubmit={ensureStableAdmissionPeriodCommandId}
            aria-labelledby={titleId}
            aria-describedby={relevantFailure ? actionErrorId : undefined}
            aria-busy={revising}
            className="mx-auto grid max-w-3xl gap-5"
          >
            <input type="hidden" name="_intent" value="revise" />
            <input type="hidden" name="admissionPeriodId" value={period.id} />
            <input type="hidden" name="etag" value={period.etag} />
            <input
              type="hidden"
              name="commandId"
              value={commandId || relevantFailure?.commandId || ""}
              readOnly
            />

            <div>
              <h3 id={titleId} className="font-semibold text-base">
                Revider opptaksperioden
              </h3>
              <p className="mt-1 text-muted-foreground text-sm">
                Du reviderer versjon {period.revision}. Periodens identitet og historiske søknader
                blir ikke endret.
              </p>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${fieldId}-start`}>
                  Starter (UTC)
                  <span className="font-normal text-muted-foreground">(påkrevd)</span>
                </Label>
                <Input
                  id={`${fieldId}-start`}
                  name="startAt"
                  type="datetime-local"
                  step={60}
                  required
                  defaultValue={draft?.startAt ?? period.startAtInput}
                  aria-invalid={relevantFailure?.error.field === "startAt" || undefined}
                  aria-describedby={fieldDescription(
                    `${fieldId}-start-help`,
                    "startAt",
                    actionErrorId,
                    relevantFailure,
                  )}
                />
                <p id={`${fieldId}-start-help`} className="text-muted-foreground text-xs">
                  Tidspunktet tolkes og lagres som UTC.
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor={`${fieldId}-end`}>
                  Slutter (UTC)
                  <span className="font-normal text-muted-foreground">(påkrevd)</span>
                </Label>
                <Input
                  id={`${fieldId}-end`}
                  name="endAt"
                  type="datetime-local"
                  step={60}
                  required
                  defaultValue={draft?.endAt ?? period.endAtInput}
                  aria-invalid={relevantFailure?.error.field === "endAt" || undefined}
                  aria-describedby={fieldDescription(
                    `${fieldId}-end-help`,
                    "endAt",
                    actionErrorId,
                    relevantFailure,
                  )}
                />
                <p id={`${fieldId}-end-help`} className="text-muted-foreground text-xs">
                  Sett slutt før gjeldende klokkeslett for å stenge nye søknader.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={revising}
                onClick={() => setEditing(false)}
              >
                Avbryt
              </Button>
              <Button type="submit" disabled={revising}>
                {revising ? "Lagrer …" : "Lagre ny versjon"}
              </Button>
            </div>
          </Form>
        </TableCell>
      </TableRow>
    </Fragment>
  );
}
