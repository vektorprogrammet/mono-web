import { Context, Effect } from "effect";
import type {
  AdmissionPeriodCommandContext,
  AdmissionPeriodManagementContext,
  AdmissionPeriodTransactionResult,
} from "../admission-period/context.js";
import type { AdmissionPeriodFailure } from "../admission-period/errors.js";
import {
  type AdmissionPeriodProjection,
  type AdmissionPeriodCommand,
} from "../admission-period/schema.js";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import type { PersonId } from "../organization/schema.js";
import type { OutcomeMailRenderer } from "./template.js";
import type {
  AdmissionOutcomeBoard,
  AdmissionOutcomeCommand,
  AdmissionOutcomeEntry,
  AdmissionOutcomeOperationFailure,
  AdmissionOutcomeScope,
  AdmissionOutcomeScopes,
} from "./outcome.js";
import type {
  ApplicantContactProjectionFailure,
  PublicApplicationError,
} from "../application/errors.js";
import {
  type ApplicantContactProjection,
  type ApplicantProgressResponse,
  type PublicApplicationCatalogContext,
  type PublicApplicationCatalogHttpSource,
  type PublicApplicationConfirmation,
  type PublicApplicationSubmitContext,
  type PublicApplicationId,
  type PublicApplicationSubmitResult,
  type PublicApplicationSubmitInput,
} from "../application/schema.js";

export interface AdmissionsOperations {
  readonly executeAdmissionPeriod: (
    input: AdmissionPeriodCommand,
    context: AdmissionPeriodCommandContext,
  ) => Effect.Effect<AdmissionPeriodTransactionResult, AdmissionPeriodFailure>;
  readonly listAdmissionPeriodsForManagement: (
    context: AdmissionPeriodManagementContext,
  ) => Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure>;
  readonly listOpenAdmissionPeriods: (
    now: string,
  ) => Effect.Effect<ReadonlyArray<AdmissionPeriodProjection>, AdmissionPeriodFailure>;
  readonly executePublicApplication: (
    input: PublicApplicationSubmitInput,
    context: PublicApplicationSubmitContext,
  ) => Effect.Effect<PublicApplicationSubmitResult, PublicApplicationError>;
  readonly listPublicApplicationCatalog: (
    context: PublicApplicationCatalogContext,
  ) => Effect.Effect<PublicApplicationCatalogHttpSource, PublicApplicationError>;
  readonly findPublicApplicationConfirmation: (
    applicationId: string,
  ) => Effect.Effect<PublicApplicationConfirmation, PublicApplicationError>;
  readonly readApplicantContacts: (
    applicationIds: ReadonlyArray<PublicApplicationId>,
  ) => Effect.Effect<ReadonlyArray<ApplicantContactProjection>, ApplicantContactProjectionFailure>;
  readonly readApplicantProgress: (
    personId: string,
    now: string,
  ) => Effect.Effect<ApplicantProgressResponse, PublicApplicationError>;
  /** Projects visible outcome scopes from supplied current authority; does not authenticate it. */
  readonly listAdmissionOutcomeScopes: (
    authority: OrganizationPersonAuthority,
  ) => Effect.Effect<AdmissionOutcomeScopes, AdmissionOutcomeOperationFailure>;
  /** Includes every application of the period with its contact data. The caller projects it. */
  readonly readAdmissionOutcomes: (
    scope: AdmissionOutcomeScope,
  ) => Effect.Effect<AdmissionOutcomeBoard, AdmissionOutcomeOperationFailure>;
  /** Selects one application's entry. The caller checks scope and projects it. */
  readonly readAdmissionOutcome: (
    applicationId: AdmissionOutcomeEntry["applicationId"],
  ) => Effect.Effect<AdmissionOutcomeEntry, AdmissionOutcomeOperationFailure>;
  /**
   * Rekruttering decides an application that its interview does not derive (`Kanskje`, or a
   * returning assistant without an interview). Runs inside the caller's transaction after
   * current authority and receipt lookup. Takes the department lock that placement writes take,
   * locks the application, reads the current entry, checks the transport precondition, and
   * appends the next outcome revision. Deciding the current outcome again changes nothing.
   * `Rejected` is refused while the person holds an active placement in the department and
   * semester. `Ja`, `Nei`, an unreviewed application and an announced outcome are refused.
   * The callback grants no authority and must not perform business writes.
   * Its failures and requirements propagate unchanged. Success precedes caller commit.
   */
  readonly decideAdmissionOutcome: <E, R>(
    input: {
      readonly applicationId: AdmissionOutcomeEntry["applicationId"];
      readonly command: AdmissionOutcomeCommand;
      readonly actor: PersonId;
      readonly now: string;
    },
    checkPrecondition: (current: AdmissionOutcomeEntry) => Effect.Effect<void, E, R>,
  ) => Effect.Effect<AdmissionOutcomeEntry, AdmissionOutcomeOperationFailure | E, R>;
  /**
   * The school coordinator announces the one final outcome of an application, once. Runs inside
   * the caller's transaction like `decideAdmissionOutcome` and takes the same locks. Derives
   * `Ja` as Admitted and `Nei` as Rejected, requires the decision of `Kanskje` and returning, and
   * refuses `Rejected` while the person holds an active placement. It appends the derived
   * revision, writes the terminal announcement, and then queues the one immutable mail
   * envelope that `render` produces from the current template, inside the same transaction.
   * A later placement never rewrites the outcome. The callbacks grant no authority; their
   * failures and requirements propagate unchanged. Success precedes caller commit.
   */
  readonly announceAdmissionOutcome: <E, R, RenderE, RenderR>(
    input: {
      readonly applicationId: AdmissionOutcomeEntry["applicationId"];
      readonly actor: PersonId;
      readonly now: string;
    },
    checkPrecondition: (current: AdmissionOutcomeEntry) => Effect.Effect<void, E, R>,
    render: OutcomeMailRenderer<RenderE, RenderR>,
  ) => Effect.Effect<
    AdmissionOutcomeEntry,
    AdmissionOutcomeOperationFailure | E | RenderE,
    R | RenderR
  >;
}

export class Admissions extends Context.Service<Admissions, AdmissionsOperations>()(
  "@vektorprogrammet/domain/Admissions",
) {}
