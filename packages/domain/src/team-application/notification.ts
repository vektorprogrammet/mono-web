import { Data, Schema } from "effect";
import { ContactEmail } from "../contact/schema.js";
import { TeamId } from "../organization/schema.js";
import { TeamApplicationCommandId, TeamApplicationId, type TeamApplication } from "./schema.js";

const EffectIdentity = {
  effectId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  commandId: TeamApplicationCommandId,
  teamId: TeamId,
  applicationId: TeamApplicationId,
};

/** Non-private durable identity of one committed notification effect; stored as columns. */
export const TeamApplicationOutboxRequest = Schema.TaggedUnion({
  SendTeamApplicationReceipt: EffectIdentity,
  NotifyTeamOfApplication: EffectIdentity,
});

export type TeamApplicationOutboxRequest = typeof TeamApplicationOutboxRequest.Type;

/**
 * Private mail content fixed when the application commits and stored as the outbox
 * payload. The transport adds its configured sender. Delivery, quarantine, or deletion
 * clears the stored payload.
 */
export const TeamApplicationEnvelope = Schema.Struct({
  deliveryId: EffectIdentity.effectId,
  recipient: ContactEmail,
  replyTo: ContactEmail,
  subject: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(998))),
  text: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32_768))),
}).annotate({ identifier: "TeamApplicationEnvelope" });

export type TeamApplicationEnvelope = typeof TeamApplicationEnvelope.Type;

export interface TeamApplicationNotification {
  readonly request: TeamApplicationOutboxRequest;
  readonly envelope: TeamApplicationEnvelope;
}

/**
 * Renders the applicant receipt and the team notification. The receipt replies to
 * the team mailbox; the team notification replies to the applicant.
 */
export const teamApplicationNotifications = (
  commandId: TeamApplicationCommandId,
  application: TeamApplication,
  teamName: string,
  teamMailbox: typeof ContactEmail.Type,
): readonly [TeamApplicationNotification, TeamApplicationNotification] => {
  const team = teamName.replace(/\p{Cc}+/gu, " ");

  const identity = {
    commandId,
    teamId: application.teamId,
    applicationId: application.applicationId,
  };

  const receiptId = `${commandId}:SendTeamApplicationReceipt`;
  const notificationId = `${commandId}:NotifyTeamOfApplication`;

  return [
    {
      request: TeamApplicationOutboxRequest.cases.SendTeamApplicationReceipt.make({
        ...identity,
        effectId: receiptId,
      }),
      envelope: {
        deliveryId: receiptId,
        recipient: application.email,
        replyTo: teamMailbox,
        subject: `Søknad til ${team} mottatt`,
        text: [
          "Vi har mottatt søknaden din på vektorprogrammet.no.",
          "Leder i teamet vil ta kontakt med deg snart.",
          "",
          "Vi gleder oss til å møte deg!",
          `Vennlig hilsen ${team}, Vektorprogrammet`,
        ].join("\n"),
      },
    },
    {
      request: TeamApplicationOutboxRequest.cases.NotifyTeamOfApplication.make({
        ...identity,
        effectId: notificationId,
      }),
      envelope: {
        deliveryId: notificationId,
        recipient: teamMailbox,
        replyTo: application.email,
        subject: `Ny søker til ${team}`,
        text: [
          "Dere har fått en ny søker.",
          "",
          `Navn: ${application.name}`,
          `E-post: ${application.email}`,
          `Telefon: ${application.phone}`,
          `Studieår: ${application.yearOfStudy}`,
          `Linje: ${application.fieldOfStudy}`,
          "",
          "Om søkeren:",
          application.biography,
          "",
          "Motivasjon:",
          application.motivation,
          "",
          "Se søknaden i kontrollpanelet.",
        ].join("\n"),
      },
    },
  ];
};

export type TeamApplicationOutboxDelivery = Data.TaggedEnum<{
  readonly Idle: {};
  readonly Delivered: { readonly effectId: string };
  readonly Failed: { readonly effectId: string; readonly failureTag: string };
  /** The stored envelope could not be decoded; the effect stops and its payload is cleared. */
  readonly Quarantined: { readonly effectId: string; readonly failureTag: string };
  /** Deletion or stale recovery removed the claim before the attempt finished. */
  readonly ClaimLost: { readonly effectId: string };
}>;

export const TeamApplicationOutboxDelivery = Data.taggedEnum<TeamApplicationOutboxDelivery>();
