/** Recruitment HTTP access: person and invitation-capability authorization and access contexts. */
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
  type CanonicalScopeResolution,
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
import { Effect, Match, Option, Predicate, type Schema } from "effect";
import { resolveRequestPersonAuthorityInTransaction } from "../authority.js";
import { HttpSemanticFailure } from "../http-semantics.js";
import { authorizePersonNativeOperation } from "../native-operation.js";
import type { RecruitmentApiHttpOptions } from "./http-context.js";

type GenericFacts = Schema.JsonObject;

const capabilityForSpec = (spec: AccessSpec) =>
  Predicate.isTagged(spec.capabilities, "One")
    ? Effect.succeed(spec.capabilities.capability)
    : Effect.fail(new HttpSemanticFailure("internal.error", 500));

const rejectedCode = (status: 401 | 403 | 404) =>
  Match.value(status).pipe(
    Match.when(401, () => "credential.invalid" as const),
    Match.when(404, () => "resource.not-found" as const),
    Match.orElse(() => "authority.denied" as const),
  );

export const authorizePersonOperation = (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
  readonly actor: RecruitmentActor;
  readonly resolution: CanonicalScopeResolution<GenericFacts>;
  readonly grantScopes: ReadonlyArray<Scope>;
  readonly authorizationInstant: string;
}) =>
  Effect.gen(function* () {
    const principal = { _tag: "Person" as const, personId: input.actor.personId };
    const instant = AuthorizationInstant.make(input.authorizationInstant);
    const capability = yield* capabilityForSpec(input.spec);

    const grants = input.grantScopes.map((scope, index) =>
      decodeGrant({
        grantId: GrantId.make(
          `native-recruitment:${input.actor.personId}:${capability.type}:${index}`,
        ),
        subject: principal,
        capability,
        scope,
        startAt: instant,
        endAt: null,
        requirements: [],
        source: AuthorityRef.make("native-recruitment-actor"),
        revision: 0,
      }),
    );

    const bearer = input.request.headers.get("authorization")?.startsWith("Bearer ") === true;

    const evaluation = yield* evaluateAccessJourney(input.spec, undefined, {
      now: Effect.succeed(instant),
      resolveCredential: () =>
        Effect.succeed({
          _tag: "Accepted" as const,
          mechanism: {
            _tag: bearer ? ("OAuthUserBearer" as const) : ("BetterAuthCookie" as const),
          },
          principal,
          evidenceRef: CredentialEvidenceRef.make("native-recruitment-person"),
        }),
      resolveScope: () => Effect.succeed(input.resolution),
      resolveGrants: () => Effect.succeed(grants),
    });

    const status = accessHttpStatus(evaluation, input.spec.concealment);

    if (status !== 200) {
      return yield* Effect.fail(new HttpSemanticFailure(rejectedCode(status), status));
    }
  });

export const authorizeInvitationOperation = (input: {
  readonly spec: AccessSpec;
  readonly request: Request;
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

    const capability = yield* capabilityForSpec(input.spec);

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

    if (status !== 200) {
      return yield* Effect.fail(new HttpSemanticFailure(rejectedCode(status), status));
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

export const interviewAuthorizationInTransaction = <E, R>(
  request: Request,
  interviewId: RecruitmentInterviewId,
  endpoint:
    | typeof ScheduleInterviewEndpoint
    | typeof ReadInterviewConductEndpoint
    | typeof FinalizeInterviewEndpoint
    | typeof CancelInterviewEndpoint
    | typeof CorrectInterviewAssessmentEndpoint,
  allowLeader: boolean,
  input: RecruitmentApiHttpOptions<E, R>,
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

    yield* authorizePersonNativeOperation({
      spec: Option.getOrThrow(reflectAccessSpec(endpoint)),
      credential: authorization.credential,
      personId: actor.personId,
      resolution: {
        selection: "ExactlyOne",
        contexts: [recruitmentInterviewAccessContext(source, actor, allowLeader, activeMember)],
      },
      grantScopes: [Scope.Resource({ resource })],
      now: authorization.authorizationInstant,
    });

    return {
      actor,
      authorizationInstant: authorization.authorizationInstant,
      source,
    };
  });
