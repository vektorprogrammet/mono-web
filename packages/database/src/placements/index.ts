/**
 * Database-backed Placements, roster notification delivery, and reviewed cohort import.
 * Import from `@vektorprogrammet/database/placements` in a trusted server runtime.
 * Private adapter modules are not supported import paths.
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
