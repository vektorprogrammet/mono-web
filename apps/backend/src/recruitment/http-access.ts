/** Recruitment HTTP access: invitation-capability authorization and person access contexts. */
import type {
  Database,
  IdentitySnapshot,
  OAuthCredentialAuthority,
} from "@vektorprogrammet/database";
import type { UnauthenticatedActor } from "@vektorprogrammet/domain/admission-period";
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
import type { IdentityEngineError } from "@vektorprogrammet/domain/identity";
import type { DepartmentId, Organization } from "@vektorprogrammet/domain/organization";
import {
  Recruitment,
  type RecruitmentActor,
  type RecruitmentFailure,
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
import {
  type OrganizationResolutionError,
  resolveRequestPersonAuthorityInTransaction,
} from "../authority.js";
import { authorizePerson, personPresentation } from "../http-api/problem.js";
import type { RecruitmentApiHttpOptions } from "./http-context.js";

type GenericFacts = Schema.JsonObject;

/**
 * Authorizes the holder of an invitation's response capability.
 *
 * @remarks
 * It evaluates the invitation AccessSpec for the capability holder, with one grant of the
 * spec's one capability on the invitation resource, over the invitation's recruitment context
 * at `authorizationInstant`. The invitation AccessSpec conceals every denial as not found, so a
 * denial answers resource.not-found and no other rejection exists. A spec with another capability
 * set, or a revealed denial, is a defect.
 *
 * @sideEffects none
 *
 * @example
 * ```ts
 * yield* authorizeInvitationOperation({ spec: Option.getOrThrow(reflectAccessSpec(ReadInvitationResponseEndpoint)), source: snapshot.source, authorizationInstant: now });
 * ```
 *
 * @avoid Checking the capability digest against the invitation in the handler: the AccessSpec of
 * the contract then stops being the authority, and a denial can reveal that the invitation
 * exists. Authorize the holder with this.
 *
 * @construct http-problem
 */
export const authorizeInvitationOperation = (input: {
  readonly spec: AccessSpec;
  readonly source: RecruitmentInvitationHttpSource;
  readonly authorizationInstant: string;
}): Effect.Effect<void, Problem<"resource.not-found">> =>
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
    departmentAdministratorPersonIds:
      allowLeader &&
      Predicate.isTagged(actor, "DepartmentAdministrator") &&
      actor.departmentId === source.departmentId
        ? [actor.personId]
        : [],
  },
  authorityVersion: AuthorityVersion.make(
    `${source.interviewRevision}:${JSON.stringify(source.coInterviewerPersonId)}:${source.linkedApplicantPersonId ?? "Unknown"}:${source.authority.map((item) => `${item.kind}:${item.identity}:${item.revisions.join(".")}`).join("|")}`,
  ),
});

/** The interview that `interviewAuthorizationInTransaction` authorized, with its actor and instant. */
interface InterviewAuthorization {
  readonly actor: RecruitmentActor;
  readonly authorizationInstant: AuthorizationInstant;
  readonly source: RecruitmentInterviewHttpSource;
}

/**
 * Resolves the current person and authorizes one interview inside the caller's transaction; a
 * rejected credential is answered from the request's evidence.
 *
 * @remarks
 * It resolves the request's person credential and organization authority at one instant, lets
 * recruitment prepare the interview, which takes applicant custody before interview or receipt
 * locks, and evaluates the endpoint's AccessSpec over the interview's access context, with the
 * interview as the grant scope. `allowLeader` admits the department's administrator. It answers
 * the actor, the instant, and the interview source that the command uses.
 *
 * @sideEffects Reads the person's credential and authority, and takes recruitment's locks in the
 * caller's transaction.
 *
 * @example
 * ```ts
 * const authorization = yield* interviewAuthorizationInTransaction(request, interviewId, ScheduleInterviewEndpoint, true, input);
 * ```
 *
 * @avoid Authorizing outside the command's transaction, or before recruitment prepares the
 * interview: the authority or the interview can change before the command writes. Call it first
 * inside the transaction that writes.
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
): Effect.Effect<
  InterviewAuthorization,
  | RecruitmentFailure
  | IdentityEngineError
  | UnauthenticatedActor
  | OrganizationResolutionError
  | Problem<"authority.denied">
  | Problem<"credential.invalid">
  | Problem<"credential.missing">
  | Problem<"resource.not-found">,
  Database | IdentitySnapshot | OAuthCredentialAuthority | Organization | Recruitment
> =>
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
