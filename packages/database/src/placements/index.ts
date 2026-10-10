/**
 * Database-backed Placements, roster notification delivery, and reviewed cohort import.
 * Import from `@vektorprogrammet/database/placements` in a trusted server runtime.
 * Private adapter modules are not supported import paths.
 * Cohort imports take one native SqlClient. Reports describe current facts and provenance;
 * they become durable only when the outermost transaction commits. Nested callers own that
 * atomic cutover boundary and publish their receipt only after commit.
 * @packageDocumentation
 * @module @vektorprogrammet/database/placements
 */
export { PlacementsLive } from "./service.js";

export {
  claimNextSchoolServiceNotification,
  recoverStaleSchoolServiceNotifications,
  deliverNextSchoolServiceNotification,
  SchoolServiceNotificationDeliveryResult,
  type ClaimedSchoolServiceNotification,
  type SchoolServiceNotificationInterpreter,
} from "./outbox.js";

export {
  CurrentAssignmentFailure,
  currentAssignmentPlacementId,
  currentAssignmentImportSourceDigest,
  decodeCurrentAssignmentSnapshot,
  decodeReconciledCurrentAssignmentSnapshot,
  importCurrentAssignmentCohort,
  importReconciledCurrentAssignmentCohort,
  type CurrentAssignmentReason,
  type CurrentAssignmentOccurrence,
  type CurrentAssignmentReport,
} from "./current-assignment-cohort.js";
