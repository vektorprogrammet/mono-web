import { Effect, Match, Schema as S } from "effect";
import { Command } from "foldkit";
import { IdempotencyKey, RecruitmentMaintenanceCommand } from "@vektorprogrammet/rpc";
import { callBrowserNative } from "../../lib/browser-native";
import { nativeProblemFrom } from "../../lib/native-problem";
import { Mode } from "./model";
import {
  SucceededQuestionnaires,
  SucceededStaffing,
  FailedLoad,
  SucceededSave,
  FailedSave,
  CompletedPrepareEdit,
  type Message,
} from "./message";

export interface MaintenanceCommands {
  readonly Load: (args: { mode: Mode; requestId: number }) => Command.Command<Message>;
  readonly Save: (args: { command: RecruitmentMaintenanceCommand }) => Command.Command<Message>;
  readonly PrepareEdit: () => Command.Command<Message>;
}

export const commandsFor = (): MaintenanceCommands => {
  const Load = Command.define("LoadRecruitmentMaintenance", {
    args: { mode: Mode, requestId: S.Int },
    messages: [SucceededQuestionnaires, SucceededStaffing, FailedLoad],
    execute: ({ mode, requestId }) =>
      Effect.gen(function* () {
        const commandId = crypto.randomUUID();

        if (mode === "Questionnaires") {
          const data = yield* callBrowserNative((client) =>
            client["recruitment.readQuestionnaires"](),
          );

          return SucceededQuestionnaires({ requestId, data, commandId });
        }

        const data = yield* callBrowserNative((client) =>
          client["recruitment.readInterviewStaffing"](),
        );

        return SucceededStaffing({ requestId, data, commandId });
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
      callBrowserNative((client) =>
        client["recruitment.maintainRecruitment"]({
          idempotencyKey: IdempotencyKey.make(command.commandId),
          request: command,
        }),
      ).pipe(
          Effect.map((result) => SucceededSave({ commandId: command.commandId, result })),
          Effect.catch((error) => {
            const problem = nativeProblemFrom(error);

            const message = Match.value(problem?.code).pipe(
              Match.when("authority.denied", () => "Du har ikke tilgang til denne endringen."),
              Match.when("credential.invalid", () => "Økten er utløpt. Logg inn på nytt."),
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
              Match.when(
                "recruitment.terminal",
                () => "Intervjuet er fullført eller avlyst. Bemanningen kan ikke endres.",
              ),
              Match.when(
                "recruitment.empty-active-questionnaire",
                () => "Et aktivt intervjuskjema må ha minst ett gyldig spørsmål.",
              ),
              Match.when(
                "recruitment.invalid-command",
                () => "Kontroller spørsmål, svaralternativer og begrunnelse.",
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
                  problem?.status === 412 || problem?.code === "idempotency.digest-conflict",
              }),
            );
          }),
        ),
  });

  const PrepareEdit = Command.define("PrepareMaintenanceEdit", {
    messages: [CompletedPrepareEdit],
    execute: Effect.sync(() => CompletedPrepareEdit({ commandId: crypto.randomUUID() })),
  });

  return { Load, Save, PrepareEdit };
};
