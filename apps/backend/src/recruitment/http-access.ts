/** Recruitment HTTP access: invitation-capability authorization and person access contexts. */
import type { PublicApplicationIdSchema } from "@vektorprogrammet/domain/application";
import {
  AuthorityRef,
  AuthorityVersion,
  AuthorizationInstant,
  CapabilityId,
  CredentialEvidenceRef,
  DomainId,
  GrantId,
  INVITATION_RESPONSE_CAPABILITY,
  RECRUITMENT_INVITATION_RESOURCE_KIND,
  ResourceId,
  ResourceKind,
  Scope,
  accessHttpStatus,
  decodeGrant,
  evaluateAccessJourney,
  type AccessSpec,
} from "@vektorprogrammet/domain/authz";
import type { DepartmentId } from "@vektorprogrammet/domain/organization";
import {
  Recruitment,
  type RecruitmentActor,
  type RecruitmentInterviewHttpSource,
  type RecruitmentInterviewId,
  type RecruitmentInvitationHttpSource,
} from "@vektorprogrammet/domain/recruitment";
import {
  reflectAccessSpec,
  type CancelInterviewEndpoint,
  type CorrectInterviewAssessmentEndpoint,
  type FinalizeInterviewEndpoint,
  type ReadInterviewConductEndpoint,
  type ScheduleInterviewEndpoint,
} from "@vektorprogrammet/http-api";
import { Problem } from "@vektorprogrammet/http-api/http-semantics";
import { Effect, Option, Predicate, type Schema } from "effect";
import { resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import { authorizePerson, personPresentation } from "../http-api/problem.js";
import type { RecruitmentApiHttpOptions } from "./http-context.js";

type GenericFacts = Schema.JsonObject;

/**
 * Authorizes the holder of an invitation's response capability. The
 * invitation AccessSpec conceals every denial as not found, so a denial
 * answers resource.not-found and no other rejection exists.
 *
 * @construct http-problem
 */
export const authorizeInvitationOperation = (input: {
  readonly spec: AccessSpec;
  readonly source: RecruitmentInvitationHttpSource;
  readonly authorizationInstant: string;
}) =>
  Effect.gen(function* () {
    const capabilityId = CapabilityId.make(input.source.capabilitySha256);
    const principal = { _tag: "CapabilityHolder" as const, capabilityId };
    const instant = AuthorizationInstant.make(input.authorizationInstant);

    const resource = {
      kind: RECRUITMENT_INVITATION_RESOURCE_KIND,
      id: ResourceId.make(input.source.invitationId),
    };

    if (!Predicate.isTagged(input.spec.capabilities, "One")) {
      return yield* Effect.die(new Error("An invitation AccessSpec names exactly one capability"));
    }

    const capability = input.spec.capabilities.capability;

    const resolution = {
      selection: "ExactlyOne" as const,
      contexts: [
        {
          domainId: DomainId.make("recruitment"),
          departmentId: input.source.departmentId,
          resource,
          facts: {
            capabilityId,
            invitationId: input.source.invitationId,
            interviewId: input.source.interviewId,
            departmentId: input.source.departmentId,
            responseState: input.source.responseState,
            responseRevision: input.source.responseRevision,
            supersededAt: input.source.supersededAt,
          },
          authorityVersion: AuthorityVersion.make(
            `${input.source.scheduleRevision}:${input.source.responseRevision}`,
          ),
        },
      ],
    };

    const grant = decodeGrant({
      grantId: GrantId.make(`native-invitation:${input.source.capabilitySha256}`),
      subject: principal,
      capability,
      scope: Scope.Resource({ resource }),
      startAt: instant,
      endAt: null,
      requirements: [],
      source: AuthorityRef.make("native-invitation-capability"),
      revision: input.source.responseRevision,
    });

    const evaluation = yield* evaluateAccessJourney(input.spec, undefined, {
      now: Effect.succeed(instant),
      resolveCredential: () =>
        Effect.succeed({
          _tag: "Accepted" as const,
          mechanism: {
            _tag: "ObjectCapability" as const,
            capabilityType: INVITATION_RESPONSE_CAPABILITY,
          },
          principal,
          evidenceRef: CredentialEvidenceRef.make(
            `native-invitation:${input.source.capabilitySha256}`,
          ),
        }),
      resolveScope: () => Effect.succeed(resolution),
      resolveGrants: () => Effect.succeed([grant]),
    });

    const status = accessHttpStatus(evaluation, input.spec.concealment);

    if (status === 404) return yield* Problem.make("resource.not-found");

    if (status !== 200) {
      return yield* Effect.die(new Error(`An invitation AccessSpec revealed a ${status} denial`));
    }
  });

export const actorDepartment = (actor: RecruitmentActor): DepartmentId | null =>
  Predicate.isTagged(actor, "GlobalAdmin") ? null : actor.departmentId;

export const boardContext = (actor: RecruitmentActor, facts: GenericFacts, version: string) => ({
  domainId: DomainId.make("recruitment"),
  departmentId: actorDepartment(actor),
  resource: null,
  facts,
  authorityVersion: AuthorityVersion.make(version),
});

export const applicationContext = (input: {
  readonly applicationId: typeof PublicApplicationIdSchema.Type;
  readonly departmentId: DepartmentId;
  readonly facts: GenericFacts;
  readonly version: string;
}) => ({
  domainId: DomainId.make("recruitment"),
  departmentId: input.departmentId,
  resource: {
    kind: ResourceKind.make("application"),
    id: ResourceId.make(input.applicationId),
  },
  facts: input.facts,
  authorityVersion: AuthorityVersion.make(input.version),
});

export const recruitmentInterviewAccessContext = (
  source: RecruitmentInterviewHttpSource,
  actor: RecruitmentActor,
  allowLeader: boolean,
  activeMember: boolean,
) => ({
  domainId: DomainId.make("recruitment"),
  departmentId: source.departmentId,
  resource: {
    kind: ResourceKind.make("recruitment-interview"),
    id: ResourceId.make(source.interviewId),
  },
  facts: {
    assignedInterviewerPersonIds: activeMember ? [source.interviewerPersonId] : [],
    interviewParticipantPersonIds: activeMember
      ? source.coInterviewerPersonId === null
        ? [source.interviewerPersonId]
        : [source.interviewerPersonId, source.coInterviewerPersonId]
      : [],
    linkedApplicantPersonId: source.linkedApplicantPersonId,
    departmentLeaderPersonIds:
      allowLeader &&
      Predicate.isTagged(actor, "DepartmentLeader") &&
      actor.departmentId === source.departmentId
        ? [actor.personId]
        : [],
  },
  authorityVersion: AuthorityVersion.make(
    `${source.interviewRevision}:${JSON.stringify(source.coInterviewerPersonId)}:${source.linkedApplicantPersonId ?? "Unknown"}:${source.authority.map((item) => `${item.kind}:${item.identity}:${item.revisions.join(".")}`).join("|")}`,
  ),
});

/**
 * Resolves the current person and authorizes one interview inside the caller's
 * transaction; a rejected credential is answered from the request's evidence.
 *
 * @construct http-problem
 */
export const interviewAuthorizationInTransaction = <R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  endpoint:
    | typeof ScheduleInterviewEndpoint
    | typeof ReadInterviewConductEndpoint
    | typeof FinalizeInterviewEndpoint
    | typeof CancelInterviewEndpoint
    | typeof CorrectInterviewAssessmentEndpoint,
  allowLeader: boolean,
  input: RecruitmentApiHttpOptions<R>,
) =>
  Effect.gen(function* () {
    const authorization = yield* resolveRequestPersonAuthorityInTransaction(request, {
      now: input.config.now,
    });

    const { source, actor, activeMember } = yield* Recruitment.use((service) =>
      service.prepareInterview({
        interviewId,
        personId: authorization.authority.personId,
        authorizationInstant: authorization.authorizationInstant,
      }),
    );

    const resource = {
      kind: ResourceKind.make("recruitment-interview"),
      id: ResourceId.make(interviewId),
    };

    yield* authorizePerson(
      {
        spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
        credential: authorization.credential,
        personId: actor.personId,
        resolution: {
          selection: "ExactlyOne",
          contexts: [recruitmentInterviewAccessContext(source, actor, allowLeader, activeMember)],
        },
        grantScopes: [Scope.Resource({ resource })],
        now: authorization.authorizationInstant,
      },
      personPresentation(request),
    );

    return {
      actor,
      authorizationInstant: authorization.authorizationInstant,
      source,
    };
  });
