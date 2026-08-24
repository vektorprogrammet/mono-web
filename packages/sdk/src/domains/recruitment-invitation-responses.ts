import { Effect, Schema } from "effect";
import {
  RecruitmentDecodeError,
  RecruitmentInvitationNotFound,
  type InternalSdkError,
} from "../errors.js";
import {
  RecruitmentInvitationCapabilitySchema,
  RecruitmentInvitationRejectInputSchema,
  RecruitmentInvitationRequestNewTimeInputSchema,
  RecruitmentInvitationResponseObservationSchema,
  type RecruitmentInvitationCapability,
  type RecruitmentInvitationRejectInput,
  type RecruitmentInvitationRequestNewTimeInput,
  type RecruitmentInvitationResponseObservation,
} from "../schemas/recruitment.js";
import type { Transport } from "../transport.js";

const INVITATION_CAPABILITY_HEADER =
  "X-Recruitment-Invitation-Capability";

export interface RecruitmentInvitationResponsesDomain {
  read(
    capability: RecruitmentInvitationCapability,
  ): Effect.Effect<
    RecruitmentInvitationResponseObservation,
    InternalSdkError
  >;
  confirm(
    capability: RecruitmentInvitationCapability,
  ): Effect.Effect<void, InternalSdkError>;
  reject(
    capability: RecruitmentInvitationCapability,
    input?: RecruitmentInvitationRejectInput,
  ): Effect.Effect<void, InternalSdkError>;
  requestNewTime(
    capability: RecruitmentInvitationCapability,
    input: RecruitmentInvitationRequestNewTimeInput,
  ): Effect.Effect<void, InternalSdkError>;
}

const decodeCapability = (
  capability: unknown,
): Effect.Effect<
  RecruitmentInvitationCapability,
  RecruitmentInvitationNotFound
> =>
  Schema.decodeUnknownEffect(RecruitmentInvitationCapabilitySchema)(
    capability,
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(() => new RecruitmentInvitationNotFound()));

const decodeRejectInput = (
  input: unknown,
): Effect.Effect<RecruitmentInvitationRejectInput, RecruitmentDecodeError> =>
  Schema.decodeUnknownEffect(RecruitmentInvitationRejectInputSchema)(
    input,
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(() => new RecruitmentDecodeError()));

const decodeRequestNewTimeInput = (
  input: unknown,
): Effect.Effect<
  RecruitmentInvitationRequestNewTimeInput,
  RecruitmentDecodeError
> =>
  Schema.decodeUnknownEffect(
    RecruitmentInvitationRequestNewTimeInputSchema,
  )(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new RecruitmentDecodeError()),
  );

const invitationRequestOptions = (
  capability: RecruitmentInvitationCapability,
  expectedStatus?: number,
) => ({
  strict: true,
  errorFamily: "recruitment" as const,
  decodeError: () => new RecruitmentDecodeError(),
  headers: { [INVITATION_CAPABILITY_HEADER]: capability },
  includeCookie: false,
  ...(expectedStatus === undefined ? {} : { expectedStatus }),
});

export const createRecruitmentInvitationResponsesDomain = (
  transport: Transport,
): RecruitmentInvitationResponsesDomain => ({
  read(capability) {
    return decodeCapability(capability).pipe(
      Effect.flatMap((validCapability) =>
        transport.get(
          "/api/recruitment/invitation-response",
          RecruitmentInvitationResponseObservationSchema,
          undefined,
          invitationRequestOptions(validCapability),
        ),
      ),
    );
  },

  confirm(capability) {
    return decodeCapability(capability).pipe(
      Effect.flatMap((validCapability) =>
        transport.postVoid(
          "/api/recruitment/invitation-response/confirm",
          {},
          invitationRequestOptions(validCapability, 204),
        ),
      ),
    );
  },

  reject(capability, input) {
    return decodeCapability(capability).pipe(
      Effect.flatMap((validCapability) =>
        decodeRejectInput(input ?? {}).pipe(
          Effect.flatMap((validInput) =>
            transport.postVoid(
              "/api/recruitment/invitation-response/reject",
              validInput,
              invitationRequestOptions(validCapability, 204),
            ),
          ),
        ),
      ),
    );
  },

  requestNewTime(capability, input) {
    return decodeCapability(capability).pipe(
      Effect.flatMap((validCapability) =>
        decodeRequestNewTimeInput(input).pipe(
          Effect.flatMap((validInput) =>
            transport.postVoid(
              "/api/recruitment/invitation-response/request-new-time",
              validInput,
              invitationRequestOptions(validCapability, 204),
            ),
          ),
        ),
      ),
    );
  },
});
