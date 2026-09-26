import { Input, Select, Textarea } from "@foldkit/ui";
import { Option, Predicate, Schema } from "effect";
import { RecruitmentInterviewQuestionKindSchema } from "@vektorprogrammet/http-api";
import type { Html, HtmlBuilder } from "foldkit/html";
import type { Model } from "./model";
import {
  SelectedRecord,
  ChangedName,
  ChangedActive,
  ChangedReason,
  AddedQuestion,
  RemovedQuestion,
  MovedQuestion,
  ChangedQuestionText,
  ChangedQuestionKind,
  AddedAlternative,
  RemovedAlternative,
  MovedAlternative,
  ChangedAlternative,
  ChangedPrimary,
  ChangedCo,
  SubmittedMaintenance,
  RetriedMaintenance,
  ResumedEditing,
  RefreshedMaintenance,
  type Message,
} from "./message";

export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
  const questionnaires = model.mode === "Questionnaires";
  const pending = Predicate.isTagged(model.mutation, "Pending");

  const locked =
    model.status !== "Ready" || ["Pending", "Failed", "Conflict"].includes(model.mutation._tag);

  const title = questionnaires ? "Intervjuskjema" : "Intervjubemanning";

  const button = (text: string, message: Message, disabled = locked) =>
    h.button([h.Type("button"), h.OnClick(message), h.Disabled(disabled)], [text]);

  const input = (
    id: string,
    labelText: string,
    value: string,
    onInput: (value: string) => Message,
  ) =>
    Input.view(
      {
        id,
        value,
        onInput,
        toView: ({ input, label }) =>
          h.div(
            [h.Class("rm-field")],
            [h.label(label, [labelText]), h.input([...input, h.Disabled(locked)])],
          ),
      },
      h,
    );

  const textarea = (
    id: string,
    labelText: string,
    value: string,
    onInput: (value: string) => Message,
  ) =>
    Textarea.view(
      {
        id,
        value,
        onInput,
        toView: ({ textarea, label }) =>
          h.div(
            [h.Class("rm-field")],
            [h.label(label, [labelText]), h.textarea([...textarea, h.Disabled(locked), h.Rows(3)])],
          ),
      },
      h,
    );

  const select = (
    id: string,
    labelText: string,
    value: string,
    options: ReadonlyArray<readonly [string, string]>,
    onChange: (value: string) => Message,
  ) =>
    Select.view(
      {
        id,
        value,
        onChange,
        toView: ({ select, label }) =>
          h.div(
            [h.Class("rm-field")],
            [
              h.label(label, [labelText]),
              h.select(
                [...select, h.Disabled(locked)],
                options.map(([value, text]) => h.option([h.Value(value)], [text])),
              ),
            ],
          ),
      },
      h,
    );

  const notice: Html[] = [];

  if (model.status === "Denied")
    return h.section(
      [h.Class("recruitment-maintenance")],
      [
        h.h1([], [title]),
        h.p(
          [h.Role("alert")],
          [
            questionnaires
              ? "Bare en global administrator kan vedlikeholde intervjuskjemaer."
              : "Du har ikke tilgang til intervjubemanning.",
          ],
        ),
      ],
    );

  if (model.status === "Loading")
    notice.push(h.p([h.Role("status")], ["Henter gjeldende opplysninger …"]));

  if (model.status === "Failed")
    notice.push(
      h.p(
        [h.Role("alert")],
        [
          "Opplysningene kunne ikke hentes. Utkastet er beholdt. Prøv å laste gjeldende versjon igjen.",
        ],
      ),
    );

  if (pending) notice.push(h.p([h.Role("status")], ["Lagrer endringen …"]));

  if (Predicate.isTagged(model.mutation, "Saved"))
    notice.push(h.p([h.Role("status")], ["Endringen er lagret."]));

  if ("message" in model.mutation) notice.push(h.p([h.Role("alert")], [model.mutation.message]));

  if (Predicate.isTagged(model.mutation, "Failed"))
    notice.push(
      h.div(
        [h.Class("rm-actions")],
        [
          button("Prøv samme forespørsel igjen", RetriedMaintenance(), false),
          button("Fortsett å redigere utkastet", ResumedEditing(), false),
        ],
      ),
    );

  const selectedQuestionnaire = model.questionnaires?.questionnaires.find(
    (entry) => entry.interviewSchemaId === model.selectedId,
  );

  const selectedInterview = model.staffing?.interviews.find(
    (entry) => entry.interviewId === model.selectedId,
  );

  const questions: Html[] = model.draft.questions.map((question, index) => {
    const id = `rm-question-${question.questionId}`;

    return h.fieldset(
      [h.Key(question.questionId), h.Class("rm-question"), h.Disabled(locked)],
      [
        h.legend([], [`Spørsmål ${index + 1}`]),
        input(`${id}-prompt`, "Spørsmål", question.prompt, (value) =>
          ChangedQuestionText({ index, field: "prompt", value }),
        ),
        textarea(`${id}-help`, "Hjelpetekst (valgfritt)", question.helpText, (value) =>
          ChangedQuestionText({ index, field: "helpText", value }),
        ),
        select(
          `${id}-kind`,
          "Svartype",
          question.kind,
          [
            ["text", "Fritekst"],
            ["list", "Nedtrekksliste"],
            ["radio", "Ett valg"],
            ["check", "Flere valg"],
          ],
          (value) =>
            ChangedQuestionKind({
              index,
              kind: Option.getOrElse(
                Schema.decodeUnknownOption(RecruitmentInterviewQuestionKindSchema)(value),
                () => question.kind,
              ),
            }),
        ),
        ...(question.kind === "text"
          ? []
          : [
              h.div(
                [h.Class("rm-alternatives")],
                [
                  h.p([h.Class("rm-alternatives-label")], ["Svaralternativer i rekkefølge"]),
                  ...question.alternatives.map((value, alternative) =>
                    h.div(
                      // Draft alternatives may repeat while edited; their messages name positions.
                      [h.Key(String(alternative)), h.Class("rm-alternative")],
                      [
                        input(
                          `${id}-alternative-${alternative}`,
                          `Svaralternativ ${alternative + 1}`,
                          value,
                          (value) => ChangedAlternative({ index, alternative, value }),
                        ),
                        h.div(
                          [h.Class("rm-actions")],
                          [
                            button(
                              `Flytt svaralternativ ${alternative + 1} opp`,
                              MovedAlternative({ index, alternative, direction: -1 }),
                              locked || alternative === 0,
                            ),
                            button(
                              `Flytt svaralternativ ${alternative + 1} ned`,
                              MovedAlternative({ index, alternative, direction: 1 }),
                              locked || alternative === question.alternatives.length - 1,
                            ),
                            button(
                              `Fjern svaralternativ ${alternative + 1}`,
                              RemovedAlternative({ index, alternative }),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  button("Legg til svaralternativ", AddedAlternative({ index })),
                ],
              ),
            ]),
        h.div(
          [h.Class("rm-actions")],
          [
            button(
              `Flytt spørsmål ${index + 1} opp`,
              MovedQuestion({ index, direction: -1 }),
              locked || index === 0,
            ),
            button(
              `Flytt spørsmål ${index + 1} ned`,
              MovedQuestion({ index, direction: 1 }),
              locked || index === model.draft.questions.length - 1,
            ),
            button(`Fjern spørsmål ${index + 1}`, RemovedQuestion({ index })),
          ],
        ),
      ],
    );
  });

  const eligible =
    model.staffing?.candidates.filter(
      (candidate) => candidate.departmentId === selectedInterview?.departmentId,
    ) ?? [];

  const candidateOptions: Array<readonly [string, string]> = eligible.map((candidate) => [
    candidate.personId,
    candidate.displayName,
  ]);

  for (const id of [model.primary, model.co])
    if (id !== "" && !candidateOptions.some(([value]) => value === id))
      candidateOptions.push([id, `${id} (ikke lenger valgbar)`]);

  const history = questionnaires
    ? (model.questionnaires?.history
        .filter((entry) => entry.interviewSchemaId === model.selectedId)
        .map((entry) =>
          h.li(
            [h.Class("rm-history-entry")],
            [
              h.p([], [`Versjon ${entry.revision} · ${entry.recordedAt} · ${entry.actorPersonId}`]),
              h.p([], [entry.reason]),
              h.details(
                [],
                [
                  h.summary([], ["Vis lagret definisjon"]),
                  h.p(
                    [],
                    [
                      `${entry.after.name} · ${entry.after.active ? "Aktiv" : "Inaktiv"} · ${entry.after.questionCount} spørsmål`,
                    ],
                  ),
                  h.ol(
                    [],
                    entry.after.questions.map((question) =>
                      h.li(
                        [],
                        [
                          h.p([], [`${question.prompt} (${question.kind})`]),
                          ...(question.helpText === null ? [] : [h.p([], [question.helpText])]),
                          ...(question.alternatives.length === 0
                            ? []
                            : [
                                h.ol(
                                  [],
                                  question.alternatives.map((alternative) =>
                                    h.li([], [alternative]),
                                  ),
                                ),
                              ]),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ) ?? [])
    : (model.staffing?.history
        .filter((entry) => entry.interviewId === model.selectedId)
        .map((entry) =>
          h.li(
            [h.Class("rm-history-entry")],
            [
              h.p([], [`Versjon ${entry.revision} · ${entry.recordedAt} · ${entry.actorPersonId}`]),
              h.p([], [entry.reason]),
              h.p(
                [],
                [
                  `Fra: ${entry.before.interviewerPersonId} / ${entry.before.coInterviewerPersonId ?? "ingen medintervjuer"}`,
                ],
              ),
              h.p(
                [],
                [
                  `Til: ${entry.after.interviewerPersonId} / ${entry.after.coInterviewerPersonId ?? "ingen medintervjuer"}`,
                ],
              ),
            ],
          ),
        ) ?? []);

  const form = questionnaires
    ? h.form(
        [h.OnSubmit(SubmittedMaintenance()), h.AriaBusy(pending)],
        [
          h.fieldset(
            [h.Disabled(locked), h.Class("rm-form")],
            [
              h.legend(
                [],
                [
                  model.selectedId === ""
                    ? "Nytt intervjuskjema"
                    : `Rediger versjon ${model.expectedRevision}`,
                ],
              ),
              input("rm-name", "Navn på intervjuskjema", model.draft.name, (value) =>
                ChangedName({ value }),
              ),
              h.label(
                [h.Class("rm-checkbox")],
                [
                  h.input([
                    h.Type("checkbox"),
                    h.Checked(model.draft.active),
                    h.Disabled(locked),
                    h.OnClick(ChangedActive({ value: !model.draft.active })),
                  ]),
                  "Aktivt for nye intervjuer",
                ],
              ),
              ...(selectedQuestionnaire?.sourceState === "Unavailable"
                ? [
                    h.p(
                      [h.Role("status")],
                      [
                        "Spørsmålsgrunnlaget er tomt eller utilgjengelig. Historiske intervjuer endres ikke.",
                      ],
                    ),
                  ]
                : []),
              h.p(
                [],
                [
                  `${model.draft.questions.length} spørsmål. Eksisterende intervjuer beholder sine lagrede spørsmål.`,
                ],
              ),
              ...questions,
              button("Legg til spørsmål", AddedQuestion()),
              textarea("rm-reason", "Begrunnelse", model.reason, (value) =>
                ChangedReason({ value }),
              ),
              h.button(
                [h.Type("submit"), h.Disabled(locked)],
                [model.selectedId === "" ? "Opprett intervjuskjema" : "Lagre intervjuskjema"],
              ),
            ],
          ),
        ],
      )
    : selectedInterview
      ? h.form(
          [h.OnSubmit(SubmittedMaintenance()), h.AriaBusy(pending)],
          [
            h.fieldset(
              [h.Disabled(locked || selectedInterview.terminal), h.Class("rm-form")],
              [
                h.legend([], [`Bemanning · versjon ${model.expectedRevision}`]),
                h.p([], [`Avdeling: ${selectedInterview.departmentId}`]),
                ...(selectedInterview.terminal
                  ? [
                      h.p(
                        [h.Role("status")],
                        ["Intervjuet er fullført eller avlyst. Bemanningen kan ikke endres."],
                      ),
                    ]
                  : []),
                select(
                  "rm-primary",
                  "Hovedintervjuer",
                  model.primary,
                  [["", "Velg hovedintervjuer"], ...candidateOptions],
                  (value) => ChangedPrimary({ value }),
                ),
                select(
                  "rm-co",
                  "Medintervjuer (valgfritt)",
                  model.co,
                  [["", "Ingen medintervjuer"], ...candidateOptions],
                  (value) => ChangedCo({ value }),
                ),
                textarea("rm-reason", "Begrunnelse", model.reason, (value) =>
                  ChangedReason({ value }),
                ),
                h.p(
                  [],
                  [
                    "Tidspunkt, invitasjon, søkerens svar og lagrede spørsmål beholdes. Endringen sender ingen ny invitasjon.",
                  ],
                ),
                h.button(
                  [h.Type("submit"), h.Disabled(locked || selectedInterview.terminal)],
                  ["Lagre bemanning"],
                ),
              ],
            ),
          ],
        )
      : h.p([], ["Velg et intervju for å endre bemanningen."]);

  return h.section(
    [h.Class("recruitment-maintenance")],
    [
      h.h1([], [title]),
      h.p(
        [],
        [
          questionnaires
            ? "Globale spørsmål for nye intervjuer. Bare globale administratorer kan endre disse."
            : "Endre hovedintervjuer og medintervjuer samlet før intervjuet fullføres eller avlyses.",
        ],
      ),
      ...notice,
      h.div(
        [h.Class("rm-actions")],
        [
          button(
            "Last gjeldende versjon (erstatter utkast)",
            RefreshedMaintenance(),
            pending || model.status === "Loading",
          ),
        ],
      ),
      ...(model.questionnaires === null && model.staffing === null
        ? []
        : [
            questionnaires
              ? select(
                  "rm-record",
                  "Velg intervjuskjema",
                  model.selectedId,
                  [
                    ["", "Nytt intervjuskjema"],
                    ...(model.questionnaires?.questionnaires.map(
                      (entry): readonly [string, string] => [
                        entry.interviewSchemaId,
                        `${entry.name} (${entry.active ? "aktivt" : "inaktivt"}, versjon ${entry.revision})`,
                      ],
                    ) ?? []),
                  ],
                  (id) => SelectedRecord({ id }),
                )
              : select(
                  "rm-record",
                  "Velg intervju",
                  model.selectedId,
                  [
                    ["", "Velg intervju"],
                    ...(model.staffing?.interviews.map((entry): readonly [string, string] => [
                      entry.interviewId,
                      `${entry.applicantName} · ${entry.departmentId}${entry.terminal ? " (avsluttet)" : ""}`,
                    ]) ?? []),
                  ],
                  (id) => SelectedRecord({ id }),
                ),
            form,
            h.section(
              [h.AriaLabel("Vedlikeholdshistorikk")],
              [
                h.h2([], ["Historikk"]),
                history.length === 0
                  ? h.p([], ["Ingen vedlikeholdsendringer registrert for dette valget."])
                  : h.ol([], history),
              ],
            ),
          ]),
    ],
  );
};
