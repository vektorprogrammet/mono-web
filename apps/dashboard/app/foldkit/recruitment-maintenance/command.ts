import { Effect, Match, Predicate, Schema as S } from "effect";
import { Command } from "foldkit";
import * as Dom from "foldkit/dom";
import { correctionReopenTarget } from "./correction-window";
import { IdempotencyKey, RecruitmentMaintenanceCommand } from "@vektorprogrammet/http-api";
import { createEffectClient } from "@vektorprogrammet/sdk/effect";
import { resolveBrowserApiUrl } from "../../lib/browser-api";
import { nativeProblemFrom } from "../../lib/native-problem";
import { Mode, WorkflowFocusTicket } from "./model";
import {
  SucceededQuestionnaires,
  SucceededStaffing,
  FailedLoad,
  SucceededSave,
  FailedSave,
  CompletedPrepareEdit,
  CompletedWorkflowFocus,
  FailedWorkflowFocus,
  CompletedCancelMaintenanceLoad,
  type Message,
} from "./message";

export interface MaintenanceCommands {
  readonly Load: (args: { mode: Mode; requestId: number }) => Command.Command<Message>;
  readonly CancelLoad: (requestId: number) => Command.Command<Message>;
  readonly Save: (args: { command: RecruitmentMaintenanceCommand }) => Command.Command<Message>;
  readonly PrepareEdit: () => Command.Command<Message>;
}

/** One invocation per ticket; the interview key addresses all holders, never serializes them.
 * Update waits for CompletedCancelWorkflowFocus before admitting another dialog. */
export const FocusCorrectionReopen = Command.define("FocusCorrectionReopen", {
  args: WorkflowFocusTicket.fields,
  messages: [CompletedWorkflowFocus, FailedWorkflowFocus],
  interrupt: { keyFields: ["interviewId"], toKey: ({ interviewId }) => interviewId },
  execute: (ticket) => Dom.focus(correctionReopenTarget(ticket.interviewId).selector).pipe(
    Effect.as(CompletedWorkflowFocus({ ticket })),
    Effect.catchTag("ElementNotFound", () => Effect.succeed(FailedWorkflowFocus({ ticket }))),
  ),
});

export const commandsFor = (
  client = createEffectClient(resolveBrowserApiUrl(import.meta.env.VITE_API_URL, globalThis.location.origin)),
): MaintenanceCommands => {

  const Load = Command.define("LoadRecruitmentMaintenance", {
    args: { mode: Mode, requestId: S.Int },
    messages: [SucceededQuestionnaires, SucceededStaffing, FailedLoad],
    interrupt: { keyFields: ["requestId"], toKey: ({ requestId }) => String(requestId) },
    execute: ({ mode, requestId }) =>
      Effect.gen(function* () {
        const commandId = crypto.randomUUID();

        if (mode === "Questionnaires") {
          const result = yield* client.recruitment.readQuestionnaires();

          return SucceededQuestionnaires({ requestId, data: result.body, commandId });
        }

        const result = yield* client.recruitment.readInterviewStaffing();

        return SucceededStaffing({ requestId, data: result.body, commandId });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            FailedLoad({
              requestId,
              denied: [401, 403].includes(nativeProblemFrom(error)?.status ?? 0),
            }),
          ),
        ),
      ),
  });

  const Save = Command.define("SaveRecruitmentMaintenance", {
    args: { command: RecruitmentMaintenanceCommand },
    messages: [SucceededSave, FailedSave],
    execute: ({ command }) =>
      client.recruitment
        .maintainRecruitment({
          payload: command,
          headers: { "idempotency-key": IdempotencyKey.make(command.commandId) },
        })
        .pipe(
          Effect.map(({ body }) => SucceededSave({ commandId: command.commandId, result: body })),
          Effect.catch((error) => {
            const problem = nativeProblemFrom(error);

            const windowCommand =
              Predicate.isTagged(command, "ReopenAssessmentCorrection") ||
              Predicate.isTagged(command, "CloseAssessmentCorrection");

            const message = Match.value(problem?.code).pipe(
              Match.when("authority.denied", () => "Du har ikke tilgang til denne endringen."),
              Match.when("credential.invalid", () => "Økten er utløpt. Logg inn på nytt."),
              Match.when("resource.not-found", () =>
                windowCommand
                  ? "Intervjuet finnes ikke lenger. Utkastet er beholdt; last gjeldende versjon."
                  : "Lagringen kunne ikke bekreftes. Utkastet er beholdt. Prøv samme forespørsel igjen.",
              ),
              Match.when(
                "precondition.failed",
                () =>
                  "En annen bruker har endret opplysningene. Utkastet er beholdt. Last gjeldende versjon før du lagrer.",
              ),
              Match.when(
                "recruitment.ineligible",
                () =>
                  "Velg to ulike, aktive medlemmer i intervjuets avdeling. Søkeren kan ikke være intervjuer.",
              ),
              Match.when("recruitment.terminal", () =>
                windowCommand
                  ? "Serveren avviste endringen: rettingsvindu krever et fullført, ikke avlyst intervju innen søkerens semester. Utkastet er beholdt."
                  : "Intervjuet er fullført eller avlyst. Bemanningen kan ikke endres.",
              ),
              Match.when(
                "recruitment.empty-active-questionnaire",
                () => "Et aktivt intervjuskjema må ha minst ett gyldig spørsmål.",
              ),
              Match.when("recruitment.invalid-command", () =>
                windowCommand
                  ? "Serveren avviste rettingsvinduet. Kontroller begrunnelse og sluttidspunkt innen søkerens eget semester. Utkastet er beholdt."
                  : "Kontroller spørsmål, svaralternativer og begrunnelse.",
              ),
              Match.when(
                "idempotency.digest-conflict",
                () => "Forespørselen er allerede brukt med annet innhold. Last gjeldende versjon.",
              ),
              Match.orElse(
                () =>
                  "Lagringen kunne ikke bekreftes. Utkastet er beholdt. Prøv samme forespørsel igjen.",
              ),
            );

            return Effect.succeed(
              FailedSave({
                commandId: command.commandId,
                message,
                conflict:
                  problem?.status === 412 ||
                  problem?.code === "idempotency.digest-conflict" ||
                  (windowCommand &&
                    problem !== undefined &&
                    [
                      "authority.denied",
                      "credential.invalid",
                      "resource.not-found",
                      "recruitment.terminal",
                      "recruitment.invalid-command",
                    ].includes(problem.code)),
              }),
            );
          }),
        ),
  });

  const PrepareEdit = Command.define("PrepareMaintenanceEdit", {
    messages: [CompletedPrepareEdit],
    execute: Effect.sync(() => CompletedPrepareEdit({ commandId: crypto.randomUUID() })),
  });

  const CancelLoad = (requestId: number) => Load.Interrupt({ requestId }, (outcome) => CompletedCancelMaintenanceLoad({ requestId, outcome }));

  return { Load, CancelLoad, Save, PrepareEdit };
};
