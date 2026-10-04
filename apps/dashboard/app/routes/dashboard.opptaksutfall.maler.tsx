import {
  IdempotencyIfMatchHeaders,
  OutcomeTemplateDraft,
  OutcomeTemplateKind,
  type OutcomeTemplateResource,
  type StrongETag,
} from "@vektorprogrammet/http-api";
import { DepartmentId } from "@vektorprogrammet/domain/organization";
import {
  OutcomeMailValues,
  outcomeTemplateKinds,
  outcomeTemplatePlaceholders,
} from "@vektorprogrammet/domain/admissions/template";
import { Match, Option, Schema } from "effect";
import { Suspense, lazy, useState, useSyncExternalStore } from "react";
import {
  Form,
  Link,
  data,
  href,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigation,
} from "react-router";
import { Button } from "../components/ui/button";
import {
  outcomeTemplateKindLabels,
  placeholderLabels,
  templateDraftOf,
  templateDraftProblems,
  type TemplateDraft,
} from "../components/outcome-templates/template-document";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import { formText } from "../lib/form-text";
import { nativeProblemFrom } from "../lib/native-problem";
import type { Route } from "./+types/dashboard.opptaksutfall.maler";

const privateData = <T,>(value: T, status = 200) =>
  data(value, { status, headers: { "Cache-Control": "private, no-store" } });

const TemplateQuery = Schema.Struct({ departmentId: Schema.optional(DepartmentId) });

const readFailure = (code: string | undefined) =>
  Match.value(code).pipe(
    Match.when(
      "authority.denied",
      () =>
        "Du har ikke tilgang til disse malene. Globale standardmaler leses av en global administrator, og avdelingsmaler av avdelingens delegerte skolekoordinator.",
    ),
    Match.when("scope.invalid", () => "Velg en gyldig avdeling."),
    Match.orElse(() => "Malene kunne ikke lastes. Prøv igjen."),
  );

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const query = new URL(request.url).searchParams;
  const departmentId = query.get("departmentId") ?? "";
  const kind = Option.getOrNull(Schema.decodeUnknownOption(OutcomeTemplateKind)(query.get("kind")));

  // The department list is the departments of the outcome board. A person without one may
  // still edit the global default, so a refusal here is an empty list, not an error.
  const departments = await client.admissionOutcomes.listScopes().then(
    (scopes) => scopes.body.departments,
    () => [],
  );

  const selection = { departmentId, kind, departments };

  if (kind === null) return privateData({ ...selection, resource: null, error: null });

  try {
    const result = await client.admissionOutcomes.readOutcomeTemplates({
      query: Schema.decodeSync(TemplateQuery)(departmentId === "" ? {} : { departmentId }),
      headers: {},
    });

    if (result.body === undefined) throw new Error("The template response had no body");

    return privateData({ ...selection, resource: result.body, error: null });
  } catch (cause) {
    return privateData({
      ...selection,
      resource: null,
      error: readFailure(nativeProblemFrom(cause)?.code),
    });
  }
}

const SaveRequest = Schema.Struct({
  params: Schema.Struct({ kind: OutcomeTemplateKind }),
  query: TemplateQuery,
  headers: IdempotencyIfMatchHeaders,
  payload: Schema.fromJsonString(OutcomeTemplateDraft),
});

const PreviewRequest = Schema.Struct({
  params: Schema.Struct({ kind: OutcomeTemplateKind }),
  query: TemplateQuery,
  draft: Schema.fromJsonString(OutcomeTemplateDraft),
  sample: Schema.fromJsonString(OutcomeMailValues),
});

type Intent = "preview" | "save";

const failureMessage = (code: string | undefined, intent: Intent) =>
  Match.value(code).pipe(
    Match.when(
      "authority.denied",
      () =>
        "Du har ikke tilgang til å redigere denne malen. Globale standardmaler redigeres av en global administrator, og avdelingsmaler av avdelingens delegerte skolekoordinator.",
    ),
    Match.when(
      "admission-outcome.template-invalid",
      () =>
        "Serveren avviste malen. Den inneholder innhold, lenker eller plassholdere som ikke er tillatt.",
    ),
    Match.when("idempotency.in-flight", () => "Malen lagres allerede. Vent litt og prøv igjen."),
    Match.when("validation.failed", () => "Malen eller eksempelverdiene er ugyldige."),
    Match.when("scope.invalid", () => "Velg en gyldig avdeling."),
    Match.orElse(() =>
      intent === "preview"
        ? "Forhåndsvisningen kunne ikke lages nå. Prøv igjen."
        : "Malen kunne ikke lagres nå. Ingen endring er bekreftet. Prøv igjen.",
    ),
  );

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const form: FormData = await request.formData();
  const commandId = formText(form, "commandId");
  const signature = formText(form, "signature");
  const intent: Intent = formText(form, "intent") === "preview" ? "preview" : "save";
  const departmentId = formText(form, "departmentId");
  const params = { kind: form.get("kind") };
  const query = departmentId === "" ? {} : { departmentId };

  /** Every answer has the same fields: a failure has no rendering and no new version. */
  const answer = (
    value: {
      readonly success: boolean;
      readonly message: string;
      readonly conflict?: boolean;
      readonly rendered?: { readonly subject: string; readonly html: string; readonly text: string };
      readonly etag?: StrongETag;
    },
    status = 200,
  ) =>
    privateData(
      {
        intent,
        commandId,
        signature,
        success: value.success,
        conflict: value.conflict ?? false,
        message: value.message,
        rendered: value.rendered ?? null,
        etag: value.etag ?? null,
      },
      status,
    );

  const refused = (message: string, status: number, conflict = false) =>
    answer({ success: false, message, conflict }, status);

  if (intent === "preview") {
    const request = Schema.decodeUnknownOption(PreviewRequest)(
      { params, query, draft: form.get("draft"), sample: form.get("sample") },
      { onExcessProperty: "error" },
    );

    if (Option.isNone(request)) return refused(failureMessage("validation.failed", intent), 422);

    try {
      const rendered = (
        await client.admissionOutcomes.previewOutcomeTemplate({
          params: request.value.params,
          query: request.value.query,
          payload: { ...request.value.draft, sample: request.value.sample },
        })
      ).body;

      return answer({ success: true, message: "Forhåndsvisningen er klar.", rendered });
    } catch (cause) {
      const problem = nativeProblemFrom(cause);

      return refused(failureMessage(problem?.code, intent), problem?.status ?? 503);
    }
  }

  const save = Schema.decodeUnknownOption(SaveRequest)(
    {
      params,
      query,
      headers: { "if-match": form.get("etag"), "idempotency-key": form.get("commandId") },
      payload: form.get("draft"),
    },
    { onExcessProperty: "error" },
  );

  if (Option.isNone(save)) return refused(failureMessage("validation.failed", intent), 422);

  try {
    const saved = (await client.admissionOutcomes.saveOutcomeTemplate(save.value)).body;

    return answer({ success: true, message: "Malen er lagret.", etag: saved.etag });
  } catch (cause) {
    const problem = nativeProblemFrom(cause);

    const conflict =
      problem?.code === "precondition.failed" ||
      problem?.code === "transaction.conflict" ||
      problem?.code === "idempotency.digest-conflict";

    return refused(
      conflict
        ? "Malen er endret av noen andre. Utkastet ditt er beholdt. Hent siste versjon før du lagrer på nytt."
        : failureMessage(problem?.code, intent),
      problem?.status ?? 503,
      conflict,
    );
  }
}

// The editor imports the React Email package, so it is loaded in the browser only, after hydration.
const TemplateEditor = lazy(() =>
  import("../components/outcome-templates/template-editor").then((module) => ({
    default: module.TemplateEditor,
  })),
);

const noopSubscribe = () => () => undefined;

const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

const inputClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

// Callback ref runs only when a new command result is mounted, after its DOM exists.
function revealCommandFeedback(element: HTMLElement | null): void {
  if (element !== null) {
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest" });
  }
}

type Resource = typeof OutcomeTemplateResource.Type;

type Entry = Resource["templates"][number];

const sampleDefaults = {
  firstName: "Kari",
  departmentName: "Trondheim",
  semesterName: "Høst 2031",
  schoolName: "Eksempelskolen",
};

interface WorkspaceProps {
  readonly departmentId: string;
  readonly kind: OutcomeTemplateKind;
  readonly resource: Resource;
  readonly entry: Entry;
}

function TemplateWorkspace({ departmentId, kind, resource, entry }: WorkspaceProps) {
  const preview = useFetcher<typeof action>({ key: `preview-${departmentId}-${kind}` });
  const save = useFetcher<typeof action>({ key: `save-${departmentId}-${kind}` });
  const refresh = useFetcher<typeof loader>();
  const location = useLocation();
  const placeholders = outcomeTemplatePlaceholders(kind);

  const [draft, setDraft] = useState<TemplateDraft>(() => templateDraftOf(entry));

  const [sample, setSample] = useState(sampleDefaults);
  const [baseline, setBaseline] = useState(resource.etag);
  const [dirty, setDirty] = useState(false);
  const [command, setCommand] = useState({ signature: "", key: "" });
  const [accepted, setAccepted] = useState("");
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const [generation, setGeneration] = useState(0);
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);

  // Without a draft the workspace follows the loaded version. A draft keeps the version it was
  // made from, so a change by someone else is a conflict and never a silent overwrite.
  if (!dirty && baseline !== resource.etag) setBaseline(resource.etag);

  const sampleBase = {
    firstName: sample.firstName,
    departmentName: sample.departmentName,
    semesterName: sample.semesterName,
  };

  // `schoolName` exists only for the variant with a placement.
  const sampleValues =
    kind === "AdmittedWithSchool" ? { ...sampleBase, schoolName: sample.schoolName } : sampleBase;

  const draftJson = JSON.stringify(draft);
  const signature = JSON.stringify({ kind, departmentId, draft, sample: sampleValues });
  const previewBusy = preview.state !== "idle";
  const saveBusy = save.state !== "idle";

  const renderedMail = previewBusy ? null : (preview.data?.rendered ?? null);
  const previewed = renderedMail !== null && preview.data?.signature === signature;
  const savedEtag = saveBusy ? null : (save.data?.etag ?? null);
  const completed = savedEtag === null ? "" : (save.data?.commandId ?? "");

  if (savedEtag !== null && completed !== accepted) {
    setAccepted(completed);
    setDirty(false);
    setBaseline(savedEtag);
    setCommand({ signature: "", key: "" });
  }

  const requestPreview = () => {
    const found = templateDraftProblems(kind, draft);

    setProblems(found);

    if (found.length > 0) return;

    const body = new FormData();

    body.set("intent", "preview");
    body.set("kind", kind);
    body.set("departmentId", departmentId);
    body.set("draft", draftJson);
    body.set("sample", JSON.stringify(sampleValues));
    body.set("signature", signature);
    body.set("commandId", "");
    void preview.submit(body, { method: "post" });
  };

  const requestSave = () => {
    if (!previewed || saveBusy) return;

    // An unchanged retry reuses its key; a changed draft or version is a new command.
    const key =
      command.signature === `${signature}|${baseline}` ? command.key : crypto.randomUUID();

    setCommand({ signature: `${signature}|${baseline}`, key });

    const body = new FormData();

    body.set("intent", "save");
    body.set("kind", kind);
    body.set("departmentId", departmentId);
    body.set("etag", baseline);
    body.set("commandId", key);
    body.set("draft", draftJson);
    body.set("signature", signature);
    void save.submit(body, { method: "post" });
  };

  const feedback = saveBusy ? undefined : save.data;
  const previewFeedback = previewBusy ? undefined : preview.data;
  const latest = refresh.state === "idle" ? refresh.data?.resource : undefined;

  const provenance =
    entry.provenance === "Department"
      ? `Avdelingsmal, revisjon ${entry.revision}`
      : departmentId === ""
        ? `Global standardmal, revisjon ${entry.revision}`
        : `Global standardmal, revisjon ${entry.revision}. Når du lagrer, opprettes en avdelingsmal som erstatter den for denne varianten.`;

  return (
    <section
      key={generation}
      aria-labelledby="template-title"
      className="space-y-6"
      data-provenance={entry.provenance}
    >
      <header className="space-y-1">
        <h2 id="template-title" className="font-semibold text-xl">
          {outcomeTemplateKindLabels[kind]}
        </h2>
        <p>{provenance}</p>
        <p className="text-sm text-muted-foreground">
          Mottakerens e-postadresse er aldri en plassholder. Endringer gjelder bare nye
          kunngjøringer: e-post som allerede er sendt eller står i kø endres ikke.
        </p>
      </header>
      {mounted ? (
        <Suspense fallback={<p role="status">Laster editoren …</p>}>
          <TemplateEditor
            id="template"
            placeholders={placeholders}
            initialSubject={entry.subject}
            initialBody={entry.body}
            onChange={(next) => {
              setDraft(next);
              setDirty(true);
              setProblems([]);
            }}
          />
        </Suspense>
      ) : (
        <p role="status">Laster editoren …</p>
      )}
      <fieldset className="space-y-3 rounded-md border p-4">
        <legend className="px-1 text-sm font-medium">Eksempelverdier for forhåndsvisningen</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {placeholders.map((name) => (
            <label key={name} className="space-y-1 text-sm">
              Eksempelverdi: {placeholderLabels[name]}
              <input
                className={inputClass}
                type="text"
                value={sample[name]}
                maxLength={500}
                onChange={(event) => setSample({ ...sample, [name]: event.target.value })}
              />
            </label>
          ))}
        </div>
      </fieldset>
      {problems.length > 0 && (
        <ul role="alert" className="list-disc space-y-1 rounded-md border p-4 pl-8">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" disabled={previewBusy} onClick={requestPreview}>
          Forhåndsvis
        </Button>
        <Button
          type="button"
          disabled={!previewed || saveBusy}
          aria-describedby="save-hint"
          onClick={requestSave}
        >
          Lagre mal
        </Button>
        <p id="save-hint" className="text-sm text-muted-foreground">
          {previewed
            ? "Forhåndsvisningen stemmer med utkastet."
            : "Forhåndsvis det gjeldende utkastet før du lagrer."}
        </p>
      </div>
      {previewBusy && <p role="status">Lager forhåndsvisning …</p>}
      {saveBusy && <p role="status">Lagrer …</p>}
      {previewFeedback && !previewFeedback.success && (
        <p role="alert" className="rounded-md border bg-muted p-3 text-sm">
          {previewFeedback.message}
        </p>
      )}
      {renderedMail !== null && (
        <section aria-label="Forhåndsvisning" className="space-y-3 rounded-md border p-4">
          <h3 className="font-semibold">Forhåndsvisning</h3>
          {!previewed && (
            <p role="status">Utkastet er endret siden forhåndsvisningen. Forhåndsvis på nytt.</p>
          )}
          <p>
            <span className="font-medium">Emne:</span> {renderedMail.subject}
          </p>
          <iframe
            title="Forhåndsvisning av e-post"
            sandbox=""
            srcDoc={renderedMail.html}
            className="h-96 w-full rounded-md border bg-white"
          />
          <div>
            <h4 className="font-medium">Tekstversjon</h4>
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm">
              {renderedMail.text}
            </pre>
          </div>
        </section>
      )}
      {feedback && (
        <div
          key={feedback.commandId}
          ref={revealCommandFeedback}
          tabIndex={-1}
          role={feedback.success ? "status" : "alert"}
          className="space-y-3 rounded-md border bg-muted p-3 text-sm"
        >
          <p>{feedback.message}</p>
          {!feedback.success && feedback.conflict && (
            <>
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={refresh.state !== "idle"}
                  onClick={() => void refresh.load(`${location.pathname}${location.search}`)}
                >
                  Hent siste versjon
                </Button>
                {latest && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={baseline === latest.etag}
                      onClick={() => {
                        setBaseline(latest.etag);
                        setCommand({ signature: "", key: "" });
                      }}
                    >
                      Bruk siste versjon med mitt utkast
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setGeneration(generation + 1);
                        setDirty(false);
                        setBaseline(latest.etag);
                        setDraft(templateDraftOf(entry));
                      }}
                    >
                      Forkast utkastet og last siste mal
                    </Button>
                  </>
                )}
              </div>
              {refresh.state === "idle" && refresh.data && (
                <p>
                  {latest === null || latest === undefined
                    ? "Siste versjon kunne ikke hentes. Prøv igjen."
                    : `Siste lagrede mal er revisjon ${latest.templates.find((item) => item.kind === kind)?.revision ?? "ukjent"}.`}
                </p>
              )}
              {latest && baseline === latest.etag && (
                <p>Siste versjon er valgt. Forhåndsvis og lagre utkastet på nytt.</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default function OutcomeTemplates() {
  const { departments, departmentId, kind, resource, error } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const entry = resource?.templates.find((item) => item.kind === kind);

  return (
    <section
      className="mx-auto w-full max-w-4xl space-y-6 px-4 pb-10 sm:px-6"
      aria-labelledby="template-page-title"
    >
      <header>
        <h1 id="template-page-title" className="font-semibold text-2xl">
          E-postmaler for opptaksutfall
        </h1>
        <p className="mt-2 text-muted-foreground">
          Malene styrer e-posten som sendes når et opptaksutfall kunngjøres. Globale standardmaler
          gjelder alle avdelinger, og en avdeling kan ha sin egen mal for hver variant.
        </p>
        <p className="mt-2">
          <Link to={href("/opptaksutfall")} className="underline">
            Tilbake til opptaksutfall
          </Link>
        </p>
      </header>
      <Form
        key={`${departmentId}-${kind}`}
        method="get"
        className="flex flex-wrap items-end gap-4"
      >
        <label htmlFor="template-department" className="min-w-48 flex-1 space-y-1">
          Avdeling
          <select
            id="template-department"
            name="departmentId"
            defaultValue={departmentId}
            className={selectClass}
          >
            <option value="">Globale standardmaler</option>
            {departments.map((item) => (
              <option key={item.departmentId} value={item.departmentId}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="template-kind" className="min-w-48 flex-1 space-y-1">
          Variant
          <select
            id="template-kind"
            name="kind"
            required
            defaultValue={kind ?? ""}
            className={selectClass}
          >
            <option value="" disabled>
              Velg variant
            </option>
            {outcomeTemplateKinds.map((item) => (
              <option key={item} value={item}>
                {outcomeTemplateKindLabels[item]}
              </option>
            ))}
          </select>
        </label>
        <Button disabled={navigation.state !== "idle"}>Vis mal</Button>
      </Form>
      {error && (
        <p role="alert" className="rounded-md border p-4">
          {error}
        </p>
      )}
      {navigation.state !== "idle" && <p role="status">Henter malen …</p>}
      {!resource && !error && <p>Velg avdeling og variant for å se malen.</p>}
      {resource && entry && kind !== null && (
        <TemplateWorkspace
          key={`${departmentId}-${kind}`}
          departmentId={departmentId}
          kind={kind}
          resource={resource}
          entry={entry}
        />
      )}
    </section>
  );
}
