import { Button, Checkbox, Dialog, Input } from "@foldkit/ui";
import type {
  TeamApplicationId,
  TeamApplicationListResponse,
  TeamApplicationResource,
} from "@vektorprogrammet/http-api";
import { Option, Predicate } from "effect";
import { AsyncData } from "foldkit";
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html";
import {
  CancelledDelete,
  ChangedDeadline,
  ClearedDeadline,
  ClosedApplication,
  ConfirmedDelete,
  GotDeleteDialogMessage,
  OpenedApplication,
  RequestedDelete,
  RequestedFirstPage,
  RequestedNextPage,
  RetriedPage,
  SubmittedIntake,
  ToggledAcceptApplication,
  type Message,
} from "./message";
import {
  DEADLINE_INPUT_ID,
  DETAIL_HEADING_ID,
  INTAKE_HEADING_ID,
  LIST_HEADING_ID,
  type IntakeDraft,
  type Model,
  type Notice,
  type ReadFailure,
} from "./model";
import { instantFromOsloDateTimeLocal } from "./oslo-time";

type Page = typeof TeamApplicationListResponse.Type;

type Application = typeof TeamApplicationResource.Type;

const osloDateTime = new Intl.DateTimeFormat("nb-NO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "Europe/Oslo",
});

const instantView = (instant: string, h: HtmlBuilder<Message>): Html =>
  h.time([h.Datetime(instant)], [osloDateTime.format(new Date(instant))]);

const notices: Readonly<
  Record<Notice, { readonly key: string; readonly text: string; readonly isFailure: boolean }>
> = {
  Deleted: { key: "deleted", text: "Søknaden er slettet.", isFailure: false },
  IntakeSaved: { key: "intake-saved", text: "Søknadsinntaket er lagret.", isFailure: false },
  NoChange: { key: "no-change", text: "Ingen endringer å lagre.", isFailure: false },
  Stale: {
    key: "stale",
    text: "Inntaket ble endret av noen andre før du lagret, så endringen din ble ikke lagret. Vi har hentet den nyeste versjonen. Gjør endringen på nytt hvis den fortsatt trengs.",
    isFailure: true,
  },
  Denied: {
    key: "denied",
    text: "Du har ikke tilgang til å gjøre dette. Oversikten er oppdatert.",
    isFailure: true,
  },
  NotFound: {
    key: "application-gone",
    text: "Søknaden finnes ikke lenger. Oversikten er oppdatert.",
    isFailure: true,
  },
  Rejected: {
    key: "rejected",
    text: "Endringen ble avvist. Last siden på nytt og prøv igjen.",
    isFailure: true,
  },
  Unavailable: {
    key: "unavailable",
    text: "Tjenesten svarte ikke, så vi vet ikke om endringen ble utført. Prøv igjen. Den samme endringen blir ikke utført to ganger.",
    isFailure: true,
  },
  SessionExpired: {
    key: "session-expired",
    text: "Økten er utløpt. Last siden på nytt for å logge inn igjen.",
    isFailure: true,
  },
};

const pageFailures: Readonly<
  Record<ReadFailure, { readonly state: string; readonly title: string; readonly text: string }>
> = {
  Denied: {
    state: "denied",
    title: "Du har ikke tilgang til søknadene",
    text: "Bare nåværende medlemmer av teamet kan lese søknadene. Velg teamet ditt, eller kontakt teamlederen hvis du mener at dette er feil.",
  },
  NotFound: {
    state: "not-found",
    title: "Fant ikke teamet",
    text: "Teamet finnes ikke eller er ikke lenger aktivt.",
  },
  SessionExpired: {
    state: "session-expired",
    title: "Økten er utløpt",
    text: "Last siden på nytt for å logge inn igjen.",
  },
  Unavailable: {
    state: "unavailable",
    title: "Søknadene kunne ikke hentes",
    text: "Tjenesten svarte ikke. Prøv på nytt.",
  },
};

const detailFailures: Readonly<
  Record<ReadFailure, { readonly title: string; readonly text: string }>
> = {
  Denied: {
    title: "Du har ikke tilgang til søknaden",
    text: "Bare nåværende medlemmer av teamet kan lese søknaden.",
  },
  NotFound: {
    title: "Søknaden finnes ikke",
    text: "Søknaden kan være slettet. Oversikten er oppdatert.",
  },
  SessionExpired: {
    title: "Økten er utløpt",
    text: "Last siden på nytt for å logge inn igjen.",
  },
  Unavailable: {
    title: "Søknaden kunne ikke hentes",
    text: "Tjenesten svarte ikke. Prøv på nytt.",
  },
};

const button = (
  h: HtmlBuilder<Message>,
  config: {
    readonly label: string;
    readonly onClick?: Message;
    readonly isDisabled?: boolean;
    readonly type?: "button" | "submit";
    readonly variant?: "primary" | "secondary" | "danger";
    readonly ariaLabel?: string;
    readonly extraAttributes?: ReadonlyArray<ChildAttribute>;
  },
): Html =>
  Button.view(
    {
      type: config.type ?? "button",
      isDisabled: config.isDisabled ?? false,
      onClick: config.onClick,
      toView: ({ button: attributes }) =>
        h.button(
          [
            ...attributes,
            ...(config.extraAttributes ?? []),
            h.Class(
              `team-applications__button team-applications__button--${config.variant ?? "secondary"}`,
            ),
            ...(config.ariaLabel === undefined ? [] : [h.AriaLabel(config.ariaLabel)]),
          ],
          [config.label],
        ),
    },
    h,
  );

const noticeView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const notice = model.notice === null ? null : notices[model.notice];

  return h.div(
    [h.Class("team-applications__notice-region"), h.AriaLive("polite"), h.AriaAtomic(true)],
    notice === null
      ? []
      : [
          h.p(
            [
              h.Class(
                notice.isFailure
                  ? "team-applications__notice team-applications__notice--failure"
                  : "team-applications__notice",
              ),
              h.DataAttribute("team-application-notice", notice.key),
            ],
            [notice.text],
          ),
        ],
  );
};

const deadlineDescription = (draft: IntakeDraft) => {
  if (draft.deadline === "") {
    return {
      text: "Ingen frist. Teamet tar imot søknader så lenge inntaket er åpent.",
      isInvalid: false,
    };
  }

  return Option.match(instantFromOsloDateTimeLocal(draft.deadline), {
    onNone: () => ({
      text: "Tidspunktet finnes ikke eller finnes to ganger fordi klokken stilles for sommertid. Velg et annet tidspunkt.",
      isInvalid: true,
    }),
    onSome: (instant) => ({
      text: `Fristen blir ${osloDateTime.format(new Date(instant))} norsk tid.`,
      isInvalid: false,
    }),
  });
};

const intakeForm = (draft: IntakeDraft, model: Model, h: HtmlBuilder<Message>): Html => {
  const sending = Predicate.isTagged(model.mutation, "Sending");

  const saving =
    Predicate.isTagged(model.mutation, "Sending") &&
    Predicate.isTagged(model.mutation.request, "ReviseIntake");

  const description = deadlineDescription(draft);

  return h.form(
    [h.Class("team-applications__form"), h.OnSubmit(SubmittedIntake())],
    [
      h.fieldset(
        [h.Class("team-applications__fieldset")],
        [
          h.legend([], ["Endre søknadsinntak"]),
          Checkbox.view(
            {
              id: "team-application-accept",
              isChecked: draft.acceptApplication,
              isDisabled: sending,
              onToggle: (isChecked) => ToggledAcceptApplication({ isChecked }),
              toView: ({ checkbox, label }) =>
                h.div(
                  [h.Class("team-applications__checkbox")],
                  [
                    h.button(
                      [...checkbox, h.Class("team-applications__checkbox-box")],
                      [h.span([h.AriaHidden(true)], [draft.acceptApplication ? "✓" : ""])],
                    ),
                    h.span(
                      [...label, h.Class("team-applications__checkbox-label")],
                      ["Ta imot søknader"],
                    ),
                  ],
                ),
            },
            h,
          ),
          Input.view(
            {
              id: DEADLINE_INPUT_ID,
              type: "datetime-local",
              value: draft.deadline,
              isDisabled: sending,
              isInvalid: description.isInvalid,
              hasDescription: true,
              onInput: (value) => ChangedDeadline({ value }),
              toView: ({ input, label, description: descriptionAttributes }) =>
                h.div(
                  [h.Class("team-applications__field")],
                  [
                    h.label([...label], ["Søknadsfrist (norsk tid)"]),
                    h.input([...input, h.Class("team-applications__input")]),
                    h.p(
                      [
                        ...descriptionAttributes,
                        h.Class(
                          description.isInvalid
                            ? "team-applications__hint team-applications__hint--error"
                            : "team-applications__hint",
                        ),
                      ],
                      [description.text],
                    ),
                  ],
                ),
            },
            h,
          ),
          h.div(
            [h.Class("team-applications__actions")],
            [
              button(h, {
                label: "Fjern frist",
                onClick: ClearedDeadline(),
                isDisabled: sending || draft.deadline === "",
              }),
              button(h, {
                label: saving ? "Lagrer …" : "Lagre inntak",
                type: "submit",
                variant: "primary",
                isDisabled: sending,
              }),
            ],
          ),
        ],
      ),
    ],
  );
};

const intakeSection = (page: Page, model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("team-applications__panel"), h.AriaLabelledBy(INTAKE_HEADING_ID)],
    [
      h.h2([h.Id(INTAKE_HEADING_ID)], ["Søknadsinntak"]),
      h.p(
        [
          h.Class("team-applications__status"),
          h.DataAttribute("intake-open", page.intake.open ? "true" : "false"),
        ],
        [
          page.intake.open
            ? "Inntaket er åpent. Teamsiden viser en lenke til søknadsskjemaet."
            : "Inntaket er stengt. Teamsiden viser ingen lenke til søknadsskjemaet.",
        ],
      ),
      h.p(
        [],
        page.intake.deadline === null
          ? ["Ingen søknadsfrist er satt."]
          : ["Søknadsfrist: ", instantView(page.intake.deadline, h)],
      ),
      page.canManage && model.intakeDraft !== null
        ? intakeForm(model.intakeDraft, model, h)
        : h.empty,
    ],
  );

const listSection = (page: Page, model: Model, h: HtmlBuilder<Message>): Html => {
  const loading = AsyncData.isPending(model.page);

  return h.section(
    [h.Class("team-applications__panel"), h.AriaLabelledBy(LIST_HEADING_ID)],
    [
      h.div(
        [h.Class("team-applications__panel-heading")],
        [h.h2([h.Id(LIST_HEADING_ID)], ["Søknader"]), h.p([], [`Side ${model.pageNumber}`])],
      ),
      page.items.length === 0
        ? h.p(
            [h.Class("team-applications__empty")],
            [model.pageNumber === 1 ? "Ingen søknader er mottatt ennå." : "Ingen flere søknader."],
          )
        : h.ul(
            [h.Class("team-applications__list")],
            page.items.map((item) =>
              h.li(
                [
                  h.Key(item.applicationId),
                  h.Class("team-applications__row"),
                  h.DataAttribute("application-id", item.applicationId),
                ],
                [
                  h.div(
                    [h.Class("team-applications__row-text")],
                    [
                      h.p([h.Class("team-applications__name")], [item.name]),
                      h.p(
                        [h.Class("team-applications__meta")],
                        ["Mottatt ", instantView(item.submittedAt, h)],
                      ),
                    ],
                  ),
                  button(h, {
                    label: "Vis søknad",
                    ariaLabel: `Vis søknad fra ${item.name}`,
                    onClick: OpenedApplication({ applicationId: item.applicationId }),
                  }),
                ],
              ),
            ),
          ),
      h.nav(
        [h.Class("team-applications__actions"), h.AriaLabel("Sider med søknader")],
        [
          button(h, {
            label: "Første side",
            onClick: RequestedFirstPage(),
            isDisabled: loading || model.pageNumber === 1,
          }),
          button(h, {
            label: "Neste side",
            onClick: RequestedNextPage(),
            isDisabled: loading || page.nextCursor === undefined,
          }),
        ],
      ),
    ],
  );
};

const detailField = (
  label: string,
  value: string | Html,
  h: HtmlBuilder<Message>,
  isText = false,
): Html =>
  h.div(
    [h.Class("team-applications__field-row")],
    [
      h.dt([], [label]),
      h.dd([h.Class(isText ? "team-applications__text" : "team-applications__value")], [value]),
    ],
  );

const applicationView = (
  application: Application,
  model: Model,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  h.h2([h.Id(DETAIL_HEADING_ID)], [application.name]),
  h.p([h.Class("team-applications__meta")], ["Mottatt ", instantView(application.submittedAt, h)]),
  h.dl(
    [h.Class("team-applications__fields")],
    [
      detailField("E-post", h.a([h.Href(`mailto:${application.email}`)], [application.email]), h),
      detailField("Telefon", application.phone, h),
      detailField("Årstrinn", application.yearOfStudy, h),
      detailField("Linje", application.fieldOfStudy, h),
      detailField("Om søkeren", application.biography, h, true),
      detailField("Motivasjon", application.motivation, h, true),
    ],
  ),
  application.canManage
    ? h.div(
        [h.Class("team-applications__actions")],
        [
          button(h, {
            label: "Slett søknad",
            variant: "danger",
            onClick: RequestedDelete(),
            isDisabled: Predicate.isTagged(model.mutation, "Sending"),
          }),
        ],
      )
    : h.empty,
];

const detailSection = (
  applicationId: TeamApplicationId,
  model: Model,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.Class("team-applications__panel"),
      h.DataAttribute("application-detail", applicationId),
      h.AriaLabelledBy(DETAIL_HEADING_ID),
    ],
    [
      button(h, { label: "Tilbake til søknadene", onClick: ClosedApplication() }),
      ...AsyncData.matchData(model.detail, {
        onEmpty: () => [
          h.h2([h.Id(DETAIL_HEADING_ID)], ["Søknad"]),
          h.p([h.Role("status")], ["Henter søknaden …"]),
        ],
        onFailure: (failure) => [
          h.h2([h.Id(DETAIL_HEADING_ID)], [detailFailures[failure].title]),
          h.p([], [detailFailures[failure].text]),
          failure === "Unavailable"
            ? button(h, { label: "Prøv på nytt", onClick: OpenedApplication({ applicationId }) })
            : h.empty,
        ],
        onData: (application) => applicationView(application, model, h),
      }),
    ],
  );

const readyView = (page: Page, model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  model.selectedApplicationId === null
    ? [intakeSection(page, model, h), listSection(page, model, h)]
    : [detailSection(model.selectedApplicationId, model, h)];

const pageFailureView = (failure: ReadFailure, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Class("team-applications__panel team-applications__panel--failure"),
      h.Role("alert"),
      h.DataAttribute("team-application-state", pageFailures[failure].state),
    ],
    [
      h.h2([], [pageFailures[failure].title]),
      h.p([], [pageFailures[failure].text]),
      failure === "Unavailable"
        ? button(h, { label: "Prøv på nytt", onClick: RetriedPage(), variant: "primary" })
        : h.empty,
    ],
  );

const loadingView = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.p(
    [
      h.Class("team-applications__panel"),
      h.Role("status"),
      h.DataAttribute("team-application-state", "loading"),
    ],
    ["Henter søknader …"],
  ),
];

const deleteDialogView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const sending = Predicate.isTagged(model.mutation, "Sending");

  const applicantName = Predicate.isTagged(model.detail, "Success")
    ? model.detail.data.name
    : "søkeren";

  return h.submodel({
    slotId: model.deleteDialog.id,
    model: model.deleteDialog,
    view: Dialog.view,
    viewInputs: {
      hasDescription: true,
      toView: ({ dialog, backdrop, panel, title, description, initialFocus, isVisible }) =>
        h.dialog(
          [...dialog, h.Class("team-applications__dialog")],
          isVisible
            ? [
                h.div([...backdrop, h.Class("team-applications__dialog-backdrop")], []),
                h.div(
                  [...panel, h.Class("team-applications__dialog-panel")],
                  [
                    h.h2([...title], ["Slett søknaden?"]),
                    h.p(
                      [...description],
                      [
                        `Søknaden fra ${applicantName} og opplysningene i den slettes permanent. Dette kan ikke angres.`,
                      ],
                    ),
                    h.div(
                      [h.Class("team-applications__actions")],
                      [
                        button(h, {
                          label: "Avbryt",
                          onClick: CancelledDelete(),
                          isDisabled: sending,
                          extraAttributes: initialFocus,
                        }),
                        button(h, {
                          label: sending ? "Sletter …" : "Slett søknaden",
                          onClick: ConfirmedDelete(),
                          isDisabled: sending,
                          variant: "danger",
                        }),
                      ],
                    ),
                  ],
                ),
              ]
            : [],
        ),
    },
    toParentMessage: (message) => GotDeleteDialogMessage({ message }),
  });
};

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const held = AsyncData.getData(model.page);

  return h.section(
    [
      h.Class("team-applications"),
      h.AriaBusy(AsyncData.isPending(model.page) || Predicate.isTagged(model.mutation, "Sending")),
    ],
    [
      h.header(
        [h.Class("team-applications__header")],
        [
          h.p([h.Class("team-applications__eyebrow")], ["Team-søknader"]),
          h.h1([], [Option.isSome(held) ? `Søknader til ${held.value.teamName}` : "Søknader"]),
          h.p(
            [],
            [
              "Nåværende medlemmer av teamet kan lese søknadene. Bare teamlederen kan slette søknader og endre søknadsinntaket.",
            ],
          ),
          h.a([h.Href("../soknader"), h.Class("team-applications__link")], ["Velg et annet team"]),
        ],
      ),
      noticeView(model, h),
      ...AsyncData.match(model.page, {
        onIdle: () => loadingView(h),
        onLoading: () => loadingView(h),
        onFailure: (failure) => [pageFailureView(failure, h)],
        onRefreshing: (page) => readyView(page, model, h),
        onStale: ({ data }) => [
          h.div(
            [
              h.Class("team-applications__panel team-applications__panel--failure"),
              h.Role("alert"),
            ],
            [
              h.p([], ["Oversikten kunne ikke oppdateres. Det du ser nå, kan være utdatert."]),
              button(h, { label: "Prøv på nytt", onClick: RetriedPage(), variant: "primary" }),
            ],
          ),
          ...readyView(data, model, h),
        ],
        onSuccess: (page) => readyView(page, model, h),
      }),
      deleteDialogView(model, h),
    ],
  );
};
