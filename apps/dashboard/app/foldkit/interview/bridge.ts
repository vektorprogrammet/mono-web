import { RecruitmentInvitationResponseMessageSchema,
RecruitmentInvitationResponseObservationSchema, } from "@vektorprogrammet/http-api"
import { StrongETag } from "@vektorprogrammet/http-api";
import { Schema as S, Match } from "effect";

export const InvitationInteractionIdSchema = S.String.check(S.isPattern(/^[a-f0-9]{32}$/));

export type InvitationInteractionId = S.Schema.Type<typeof InvitationInteractionIdSchema>;

export const INVITATION_INTERACTION_HEADER = "X-Recruitment-Invitation-Interaction-Id";

export const INVITATION_INTERACTION_ATTRIBUTE = "interaction-id";

export const decodeInvitationInteractionId = S.decodeUnknownSync(InvitationInteractionIdSchema);

export const InvitationResponseActionSchema = S.Literals(["Confirm", "Reject", "RequestNewTime"]);

export type InvitationResponseAction = S.Schema.Type<typeof InvitationResponseActionSchema>;

export const InvitationResponseRequestIdSchema = S.Int.check(S.isGreaterThanOrEqualTo(0));

export const InvitationBridgeFailureSchema = S.TaggedUnion({
"InvitationNotFound": { message: S.String },
"InvitationAlreadyResponded": { message: S.String },
"InvitationDecodeError": { message: S.String },
"InvitationUnavailable": { message: S.String }
});

export type InvitationBridgeFailure = S.Schema.Type<typeof InvitationBridgeFailureSchema>;

export const InvitationBridgeOperationSchema = S.Union([
  S.Struct({ operation: S.Literal("readInvitationResponse") }),
  S.Struct({ operation: S.Literal("confirmInvitation"), etag: StrongETag }),
  S.Struct({
    operation: S.Literal("rejectInvitation"),
    etag: StrongETag,
    message: S.NullOr(S.String),
  }),
  S.Struct({
    operation: S.Literal("requestNewInvitationTime"),
    etag: StrongETag,
    message: RecruitmentInvitationResponseMessageSchema,
  }),
]);

export type InvitationBridgeOperation = S.Schema.Type<typeof InvitationBridgeOperationSchema>;

export const InvitationResponseObservationSchema = RecruitmentInvitationResponseObservationSchema;

export type InvitationResponseObservation = S.Schema.Type<
  typeof InvitationResponseObservationSchema
>;

export const InvitationResponseResourceSchema = S.Struct({
  observation: InvitationResponseObservationSchema,
  etag: StrongETag,
});

export type InvitationResponseResource = S.Schema.Type<typeof InvitationResponseResourceSchema>;

export const invitationFailureMessage = (failure: InvitationBridgeFailure): string => {
  return Match.value(failure).pipe(
Match.tag("InvitationNotFound", () => {return "Invitasjonen er ikke tilgjengelig.";}),
Match.tag("InvitationAlreadyResponded", () => {return "Invitasjonen er allerede besvart. Last siden på nytt for å se svaret.";}),
Match.tag("InvitationDecodeError", () => {return "Kontroller meldingen og prøv igjen.";}),
Match.tag("InvitationUnavailable", () => {return "Svaret kunne ikke registreres nå. Prøv igjen senere.";}),
Match.exhaustive
);
};
