import { DateTime, Effect, Match, Option, Predicate, Schema as S, Struct, flow } from "effect";
import { Command, Runtime, type Update } from "foldkit";
import { taggedStruct } from "foldkit/schema";
import type { Html, HtmlBuilder } from "foldkit/html";
import {
  DelegableCapability,
  DelegationArea,
  DelegationCommand,
  DelegationManagement,
  IdempotencyKey,
  type OrganizationCapability,
} from "@vektorprogrammet/http-api";
import { createEffectClient } from "@vektorprogrammet/sdk/effect";
import { resolveBrowserApiUrl } from "../../lib/browser-api";
import { nativeProblemFrom } from "../../lib/native-problem";
import "./styles.css";

/** Norwegian labels for every organisational capability. */
export const capabilityLabels: Record<OrganizationCapability, string> = {
  "admissions.periods": "Opptaksperioder",
  "admissions.outcomes": "Opptaksutfall og søkerkontoer",
  "recruitment.interviews": "Intervjufordeling, bemanning og rapport",
  "placements.coordinate": "Skoleplassering og vikardekning",
  "schools.administer": "Skoler og kapasitet",
  "appointments.manage": "Verv i avdelingen",
  "people.read": "Brukerkatalog og epostlister",
  "team-interest.read": "Teaminteresse",
  "content.publish": "Publisering av artikler",
  "receipts.approve": "Godkjenne og avvise utlegg (nasjonalt)",
  "receipts.settle": "Registrere utbetaling av utlegg (nasjonalt, bare ledere)",
  "delegations.manage": "Forvalte delegeringer",
  "organization.govern": "Organisasjonsstyring",
};

const Field = S.Literals([
  "name",
  "teamId",
  "capability",
  "area",
  "holders",
  "startAt",
  "endAt",
  "reason",
]);

const Operation = S.TaggedUnion({
  Ready: {},
  Loading: { command: S.NullOr(DelegationCommand) },
  Saving: { command: DelegationCommand },
  Uncertain: { command: DelegationCommand },
});

const Notice = S.TaggedUnion({
  None: {},
  Success: { message: S.String },
  Failure: { message: S.String },
});

const Model = S.Struct({
  snapshot: S.NullOr(DelegationManagement),
  requestId: S.Int,
  operation: Operation,
  notice: Notice,
  commandId: S.String,
  selected: S.String,
  name: S.String,
  teamId: S.String,
  capability: S.String,
  area: S.String,
  holders: S.String,
  startAt: S.String,
  endAt: S.String,
  reason: S.String,
});

type Model = typeof Model.Type;

const ChangedField = taggedStruct("ChangedDelegationField", { field: Field, value: S.String });

const Selected = taggedStruct("SelectedDelegation", { id: S.String });

const Submitted = taggedStruct("SubmittedDelegationCommand", {
  action: S.Literals(["IssueDelegation", "EndDelegation"]),
});

const Refreshed = taggedStruct("RefreshedDelegationManagement", {});

const Loaded = taggedStruct("LoadedDelegationManagement", {
  requestId: S.Int,
  snapshot: DelegationManagement,
  commandId: S.String,
  now: S.String,
});

const LoadFailed = taggedStruct("FailedDelegationLoad", { requestId: S.Int, message: S.String });

const Saved = taggedStruct("SavedDelegationCommand", { requestId: S.Int, commandId: S.String });

const Failed = taggedStruct("FailedDelegationCommand", {
  requestId: S.Int,
  message: S.String,
  definitive: S.Boolean,
  commandId: S.String,
});

const Retried = taggedStruct("RetriedDelegationCommand", {});

const Message = S.Union([
  ChangedField,
  Selected,
  Submitted,
  Refreshed,
  Loaded,
  LoadFailed,
  Saved,
  Failed,
  Retried,
]);

type Message = typeof Message.Type;

const failureMessage = flow(nativeProblemFrom, (problem): string => {
  const code = problem?.code;

  if (code === "precondition.failed")
    return "Delegeringen er endret av en annen bruker. Hent oppdatert oversikt før du prøver igjen.";

  if (code === "authority.denied")
    return "Du kan bare forvalte delegeringer for team i området der du leder styret.";

  if (code?.startsWith("credential.") === true) return "Økten er ikke lenger gyldig. Logg inn på nytt.";

  if (code === "validation.failed")
    return "Kontroller området, mottakerne og tidsrommet. Et lokalt team kan bare få delegering i egen avdeling, og utbetaling kan bare delegeres til teamets ledere.";

  if (code === "idempotency.digest-conflict")
    return "Kommandoen er allerede brukt med andre verdier. Hent oppdatert oversikt.";

  return "Handlingen kunne ikke fullføres. Prøv samme handling igjen, eller hent oppdatert oversikt.";
});

const instant = (value: string) =>
  value.length === 0 ? "" : value + (value.length === 16 ? ":00.000" : "") + "Z";

const parseIssue = S.decodeUnknownOption(
  DelegationCommand.cases.IssueDelegation.mapFields(Struct.omit(["_tag"])),
);

const parseEnd = S.decodeUnknownOption(
  DelegationCommand.cases.EndDelegation.mapFields(Struct.omit(["_tag"])),
);

const stateNames = { Future: "Fremtidig", Current: "Gjeldende", Ended: "Avsluttet" };

const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const busy =
    Predicate.isTagged(model.operation, "Loading") || Predicate.isTagged(model.operation, "Saving");

  const blocked = !Predicate.isTagged(model.operation, "Ready");

  const button = (label: string, message: Message, disabled = blocked) =>
    h.button([h.Type("button"), h.Disabled(disabled), h.OnClick(message)], [label]);

  const field = (key: typeof Field.Type, label: string, type = "text") =>
    h.label(
      [h.Class("organization-management__field")],
      [
        label,
        h.input([
          h.Type(type),
          h.Value(model[key]),
          h.Disabled(blocked),
          h.Maxlength(250),
          h.OnInput((value) => ChangedField({ field: key, value })),
        ]),
      ],
    );

  const select = (
    key: typeof Field.Type,
    label: string,
    options: ReadonlyArray<{ value: string; label: string }>,
  ) =>
    h.label(
      [h.Class("organization-management__field")],
      [
        label,
        h.select(
          [
            h.Value(model[key]),
            h.Disabled(blocked),
            h.OnChange((value) => ChangedField({ field: key, value })),
          ],
          [
            h.option([h.Value("")], ["Velg"]),
            ...options.map((option) => h.option([h.Value(option.value)], [option.label])),
          ],
        ),
      ],
    );

  const snapshot = model.snapshot;

  const teamName = (teamId: string) =>
    snapshot?.teams.find((team) => team.teamId === teamId)?.name ?? teamId;

  const departmentName = (departmentId: string) =>
    snapshot?.departments.find((department) => department.departmentId === departmentId)?.name ??
    departmentId;

  const team = snapshot?.teams.find((candidate) => candidate.teamId === model.teamId);

  const current = snapshot?.delegations.find(
    (delegation) => delegation.delegationId === model.selected,
  );

  const areas =
    team === undefined
      ? []
      : team.teamScope === "National"
        ? [
            { value: "Organization", label: "Hele organisasjonen" },
            ...(snapshot?.departments ?? []).map((department) => ({
              value: department.departmentId,
              label: department.name,
            })),
          ]
        : [{ value: team.departmentId, label: departmentName(team.departmentId) }];

  return h.section(
    [h.Class("organization-catalog organization-management"), h.AriaBusy(busy)],
    [
      h.h1([], ["Delegeringer"]),
      h.p(
        [],
        [
          "En delegering gir ett team én navngitt kapasitet i ett område for et tidsrom. Styreleder forvalter delegeringene for teamene i sin avdeling; Hovedstyret eller en global administrator forvalter delegeringene for nasjonale team.",
        ],
      ),
      h.p(
        [
          h.Role(Predicate.isTagged(model.notice, "Failure") ? "alert" : "status"),
          h.AriaLive("polite"),
        ],
        [busy ? "Arbeider …" : Notice.guards.None(model.notice) ? "" : model.notice.message],
      ),
      button("Hent oppdatert oversikt", Refreshed(), busy),
      Predicate.isTagged(model.operation, "Uncertain")
        ? button("Prøv nøyaktig samme handling igjen", Retried(), false)
        : h.empty,
      snapshot === null
        ? h.empty
        : h.div(
            [],
            [
              h.h2([], ["Delegeringer"]),
              h.div(
                [
                  h.Class("organization-catalog__table-scroll"),
                  h.Tabindex(0),
                  h.AriaLabel("Delegeringer, bla sidelengs ved behov"),
                ],
                [
                  h.table(
                    [h.Class("organization-catalog__table")],
                    [
                      h.caption([], ["Fremtidige, gjeldende og avsluttede delegeringer"]),
                      h.thead(
                        [],
                        [
                          h.tr(
                            [],
                            [
                              "Navn",
                              "Team",
                              "Kapasitet",
                              "Område",
                              "Mottakere",
                              "Tilstand",
                              "Tidsrom",
                              "Handling",
                            ].map((label) => h.th([h.Scope("col")], [label])),
                          ),
                        ],
                      ),
                      h.tbody(
                        [],
                        snapshot.delegations.map((delegation) =>
                          h.tr(
                            [h.Key(delegation.delegationId)],
                            [
                              h.th([h.Scope("row")], [delegation.name]),
                              h.td([], [teamName(delegation.teamId)]),
                              h.td(
                                [],
                                [capabilityLabels[delegation.capability]],
                              ),
                              h.td(
                                [],
                                [
                                  DelegationArea.guards.Department(delegation.area)
                                    ? departmentName(delegation.area.departmentId)
                                    : "Hele organisasjonen",
                                ],
                              ),
                              h.td(
                                [],
                                [delegation.holders === "LeadersOnly" ? "Bare ledere" : "Alle medlemmer"],
                              ),
                              h.td([], [stateNames[delegation.state]]),
                              h.td(
                                [],
                                [`${delegation.startAt} – ${delegation.endAt ?? "uten sluttdato"}`],
                              ),
                              h.td(
                                [],
                                [
                                  delegation.state === "Ended"
                                    ? h.empty
                                    : button(
                                        `Velg ${delegation.name}`,
                                        Selected({ id: delegation.delegationId }),
                                      ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
              h.h2([], [current ? "Avslutt valgt delegering" : "Ny delegering"]),
              current
                ? h.div(
                    [],
                    [
                      h.p(
                        [],
                        [
                          `${current.name} · ${teamName(current.teamId)} · revisjon ${current.revision}. En delegering kan avsluttes, men ikke forlenges.`,
                        ],
                      ),
                      field("endAt", "Slutt (UTC)", "datetime-local"),
                      field("reason", "Begrunnelse"),
                      h.div(
                        [h.Class("organization-management__actions")],
                        [
                          button("Avslutt delegering", Submitted({ action: "EndDelegation" })),
                          button("Ny delegering", Selected({ id: "" })),
                        ],
                      ),
                    ],
                  )
                : h.div(
                    [h.Class("organization-management__grid")],
                    [
                      field("name", "Navn"),
                      select(
                        "teamId",
                        "Team",
                        snapshot.teams.map((candidate) => ({
                          value: candidate.teamId,
                          label: `${candidate.name} (${candidate.teamScope === "National" ? "nasjonalt" : departmentName(candidate.departmentId)})`,
                        })),
                      ),
                      select(
                        "capability",
                        "Kapasitet",
                        DelegableCapability.literals.map((value) => ({
                          value,
                          label: capabilityLabels[value],
                        })),
                      ),
                      select("area", "Område", areas),
                      select("holders", "Mottakere", [
                        { value: "AllMembers", label: "Alle nåværende medlemmer" },
                        { value: "LeadersOnly", label: "Bare nåværende ledere" },
                      ]),
                      field("startAt", "Start (UTC)", "datetime-local"),
                      field("endAt", "Slutt (UTC, valgfritt)", "datetime-local"),
                      field("reason", "Begrunnelse"),
                      button("Opprett delegering", Submitted({ action: "IssueDelegation" })),
                    ],
                  ),
              h.h2([], ["Historikk"]),
              h.ol(
                [],
                snapshot.history.map((event) =>
                  h.li(
                    [],
                    [
                      `${event.occurredAt} · ${event.action === "IssueDelegation" ? "Opprettet" : "Avsluttet"} · ${event.after.name} · ${event.reason}`,
                    ],
                  ),
                ),
              ),
            ],
          ),
    ],
  );
};

export const embedDelegationManagement = (container: HTMLElement): (() => void) => {
  const client = createEffectClient(
    resolveBrowserApiUrl(import.meta.env.VITE_API_URL, globalThis.location.origin),
  );

  const Load = Command.define("LoadDelegationManagement", {
    args: { requestId: S.Int },
    messages: [Loaded, LoadFailed],
    execute: ({ requestId }) =>
      Effect.gen(function* () {
        const { body } = yield* client.organization.readDelegationManagement();
        const now = DateTime.formatIso(yield* DateTime.now);

        return Loaded({ requestId, snapshot: body, commandId: crypto.randomUUID(), now });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(LoadFailed({ requestId, message: failureMessage(error) })),
        ),
      ),
  });

  // The pinned HttpApi client distributes a union payload over whole requests.
  // Narrow only at this transport boundary; the domain owns all transitions.
  const execute = Effect.fn("organization.executeDelegation")(function* (
    command: DelegationCommand,
  ) {
    const headers = { "idempotency-key": IdempotencyKey.make(command.commandId) };

    return yield* Match.value(command).pipe(
      Match.tag("IssueDelegation", (payload) =>
        client.organization.executeDelegation({ headers, payload }),
      ),
      Match.tag("EndDelegation", (payload) =>
        client.organization.executeDelegation({ headers, payload }),
      ),
      Match.exhaustive,
    );
  });

  const Save = Command.define("SaveDelegationCommand", {
    args: { requestId: S.Int, command: DelegationCommand },
    messages: [Saved, Failed],
    execute: ({ requestId, command }) =>
      execute(command).pipe(
        Effect.map(() => Saved({ requestId, commandId: crypto.randomUUID() })),
        Effect.catch((error) => {
          const problem = nativeProblemFrom(error);

          return Effect.succeed(
            Failed({
              requestId,
              message: failureMessage(error),
              definitive: (problem?.status ?? 500) < 500 && problem?.code !== "idempotency.in-flight",
              commandId: crypto.randomUUID(),
            }),
          );
        }),
      ),
  });

  const ready = (model: Model): boolean => Predicate.isTagged(model.operation, "Ready");

  const update = (model: Model, message: Message): Update.Return<Model, Message> =>
    Match.value(message).pipe(
      Match.withReturnType<Update.Return<Model, Message>>(),
      Match.tag("ChangedDelegationField", ({ field, value }) => {
        if (!ready(model)) return { model, commands: [] };

        const changed = { ...model, [field]: value };

        // A new team has its own area; the previous choice no longer applies.
        return { model: field === "teamId" ? { ...changed, area: "" } : changed, commands: [] };
      }),
      Match.tag("SelectedDelegation", ({ id }) =>
        ready(model) ? { model: { ...model, selected: id, endAt: "" }, commands: [] } : { model, commands: [] },
      ),
      Match.tag("RefreshedDelegationManagement", () => {
        if (!ready(model) && !Predicate.isTagged(model.operation, "Uncertain"))
          return { model, commands: [] };

        const command = Predicate.isTagged(model.operation, "Uncertain")
          ? model.operation.command
          : null;

        const requestId = model.requestId + 1;

        return {
          model: { ...model, operation: Operation.cases.Loading.make({ command }), requestId },
          commands: [Load({ requestId })],
        };
      }),
      Match.tag("LoadedDelegationManagement", (loaded) => {
        if (loaded.requestId !== model.requestId || !Predicate.isTagged(model.operation, "Loading"))
          return { model, commands: [] };

        const command = model.operation.command;

        const recorded =
          command !== null &&
          loaded.snapshot.history.some((event) => event.commandId === command.commandId);

        const uncertain = recorded ? null : command;

        return {
          model: {
            ...model,
            snapshot: loaded.snapshot,
            selected: uncertain === null ? "" : model.selected,
            startAt: model.startAt || loaded.now.slice(0, 16),
            operation:
              uncertain === null
                ? Operation.cases.Ready.make({})
                : Operation.cases.Uncertain.make({ command: uncertain }),
            commandId: uncertain?.commandId ?? loaded.commandId,
            notice:
              uncertain === null
                ? Notice.cases.Success.make({
                    message: recorded
                      ? "Handlingen er lagret. Historikken bekrefter resultatet."
                      : "Oversikten er oppdatert.",
                  })
                : Notice.cases.Failure.make({
                    message: "Resultatet er fortsatt ukjent. Prøv nøyaktig samme handling igjen.",
                  }),
          },
          commands: [],
        };
      }),
      Match.tag("FailedDelegationLoad", (failed) => {
        if (failed.requestId !== model.requestId || !Predicate.isTagged(model.operation, "Loading"))
          return { model, commands: [] };

        const command = model.operation.command;

        return {
          model: {
            ...model,
            operation:
              command === null
                ? Operation.cases.Ready.make({})
                : Operation.cases.Uncertain.make({ command }),
            notice: Notice.cases.Failure.make({ message: failed.message }),
          },
          commands: [],
        };
      }),
      Match.tag("FailedDelegationCommand", (failed) => {
        if (failed.requestId !== model.requestId || !Predicate.isTagged(model.operation, "Saving"))
          return { model, commands: [] };

        return {
          model: {
            ...model,
            operation: failed.definitive
              ? Operation.cases.Ready.make({})
              : Operation.cases.Uncertain.make({ command: model.operation.command }),
            commandId: failed.definitive ? failed.commandId : model.commandId,
            notice: Notice.cases.Failure.make({ message: failed.message }),
          },
          commands: [],
        };
      }),
      Match.tag("SavedDelegationCommand", (saved) => {
        if (saved.requestId !== model.requestId || !Predicate.isTagged(model.operation, "Saving"))
          return { model, commands: [] };

        const requestId = model.requestId + 1;

        return {
          model: {
            ...model,
            operation: Operation.cases.Loading.make({ command: model.operation.command }),
            commandId: saved.commandId,
            requestId,
          },
          commands: [Load({ requestId })],
        };
      }),
      Match.tag("RetriedDelegationCommand", () => {
        if (!Predicate.isTagged(model.operation, "Uncertain")) return { model, commands: [] };

        const requestId = model.requestId + 1;

        return {
          model: {
            ...model,
            operation: Operation.cases.Saving.make({ command: model.operation.command }),
            requestId,
          },
          commands: [Save({ requestId, command: model.operation.command })],
        };
      }),
      Match.tag("SubmittedDelegationCommand", ({ action }) => {
        if (!ready(model) || model.snapshot === null) return { model, commands: [] };

        const common = { commandId: model.commandId, reason: model.reason.trim() };

        const current = model.snapshot.delegations.find(
          (delegation) => delegation.delegationId === model.selected,
        );

        const department = model.snapshot.departments.find(
          (candidate) => candidate.departmentId === model.area,
        );

        const area =
          model.area === "Organization"
            ? DelegationArea.cases.Organization.make({})
            : department === undefined
              ? undefined
              : DelegationArea.cases.Department.make({ departmentId: department.departmentId });

        const parsed: Option.Option<DelegationCommand> =
          action === "IssueDelegation"
            ? parseIssue({
                ...common,
                name: model.name.trim(),
                teamId: model.teamId,
                capability: model.capability,
                area,
                holders: model.holders,
                startAt: instant(model.startAt),
                endAt: model.endAt.length === 0 ? null : instant(model.endAt),
              }).pipe(Option.map((input) => DelegationCommand.cases.IssueDelegation.make(input)))
            : parseEnd({
                ...common,
                delegationId: current?.delegationId,
                expectedRevision: current?.revision,
                endAt: instant(model.endAt),
              }).pipe(Option.map((input) => DelegationCommand.cases.EndDelegation.make(input)));

        if (Option.isNone(parsed))
          return {
            model: {
              ...model,
              notice: Notice.cases.Failure.make({
                message: "Fyll ut navn, team, kapasitet, område, mottakere, tidsrom og begrunnelse.",
              }),
            },
            commands: [],
          };

        const requestId = model.requestId + 1;

        return {
          model: {
            ...model,
            operation: Operation.cases.Saving.make({ command: parsed.value }),
            notice: Notice.cases.None.make({}),
            requestId,
          },
          commands: [Save({ requestId, command: parsed.value })],
        };
      }),
      Match.exhaustive,
    );

  const program = Runtime.makeElement({
    Model,
    container,
    init: (): Update.Return<Model, Message> => ({
      model: {
        snapshot: null,
        requestId: 1,
        operation: Operation.cases.Loading.make({ command: null }),
        notice: Notice.cases.None.make({}),
        commandId: "",
        selected: "",
        name: "",
        teamId: "",
        capability: "",
        area: "",
        holders: "AllMembers",
        startAt: "",
        endAt: "",
        reason: "",
      },
      commands: [Load({ requestId: 1 })],
    }),
    update,
    view,
    devTools: false,
    slow: false,
    crash: {
      view: (_context, h) =>
        h.section(
          [h.Role("alert")],
          [h.h1([], ["Delegeringene kunne ikke vises"]), h.p([], ["Last siden på nytt."])],
        ),
    },
  });

  const handle = Runtime.embed(program);

  return () => handle.dispose();
};
