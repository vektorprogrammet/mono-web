/**
 * Database-backed Placements, notification delivery, and reviewed cohort import.
 * Import from `@vektorprogrammet/placements/server` in a trusted server runtime.
 * Private adapter modules are not supported import paths.
 * @packageDocumentation
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
  claimNextSchoolServiceDispatchNotification,
  recoverStaleSchoolServiceDispatchNotifications,
  deliverNextSchoolServiceDispatchNotification,
  SchoolServiceDispatchNotificationDeliveryResult,
  type ClaimedSchoolServiceDispatchNotification,
  type SchoolServiceDispatchNotificationInterpreter,
} from "./dispatch-outbox.js";

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
