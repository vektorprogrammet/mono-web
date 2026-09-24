import { Effect, Layer } from "effect";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import { Database } from "../service.js";
import { Organization } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { assignApplicant, readAssignmentBoard } from "./postgres.js";
import {
  readQuestionnaires,
  readInterviewStaffing,
  authorizeMaintenance,
  maintainRecruitment,
} from "./maintenance-postgres.js";
import { readSchedulingBoard, scheduleInterview } from "./scheduling-postgres.js";
import {
  readInterviewConduct,
  finalizeInterview,
  cancelInterview,
  correctInterviewAssessment,
} from "./conduct-postgres.js";
import {
  confirmInvitation,
  readInvitationResponse,
  rejectInvitation,
  requestNewInvitationTime,
} from "./invitation-response-postgres.js";
import { Recruitment } from "@vektorprogrammet/domain/recruitment";
import {
  prepareRecruitmentAssignment,
  prepareRecruitmentInterview,
  readRecruitmentInterviewHttpSourcePostgres,
  readRecruitmentInvitationHttpSnapshotPostgres,
  readRecruitmentPersonAuthorityHttpSourcesPostgres,
  executeRecruitmentInvitationTransitionPostgres,
} from "./http-postgres.js";
import { readCompletedInterviewReport, resolveInterviewReportLeader } from "./report-postgres.js";

/** Live Recruitment authority; all supporting capabilities remain explicit. */
export const RecruitmentLive = Layer.effect(
  Recruitment,
  Effect.gen(function* () {
    const database = yield* Database;
    const admissions = yield* Admissions;
    const organization = yield* Organization;
    const profile = yield* Profile;

    return Recruitment.of({
      prepareAssignment: (input) =>
        prepareRecruitmentAssignment(input).pipe(Effect.provideService(Database, database)),
      prepareInterview: (input) =>
        prepareRecruitmentInterview(input).pipe(Effect.provideService(Database, database)),
      readInterviewSource: (interviewId, personId) =>
        readRecruitmentInterviewHttpSourcePostgres(interviewId, personId).pipe(
          Effect.provideService(Database, database),
        ),
      readPersonAuthoritySources: (personId) =>
        readRecruitmentPersonAuthorityHttpSourcesPostgres(personId).pipe(
          Effect.provideService(Database, database),
        ),
      readInvitationSnapshot: (capability) =>
        readRecruitmentInvitationHttpSnapshotPostgres(capability).pipe(
          Effect.provideService(Database, database),
        ),
      transitionInvitation: (input) =>
        executeRecruitmentInvitationTransitionPostgres(input).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Profile, profile),
        ),
      resolveInterviewReportLeader: (personId, now) =>
        resolveInterviewReportLeader(personId, now).pipe(
          Effect.provideService(Organization, organization),
        ),
      readCompletedInterviewReport: (personId, now, query) =>
        readCompletedInterviewReport(personId, now, query).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
      readQuestionnaires: (personId) =>
        readQuestionnaires(personId).pipe(Effect.provideService(Database, database)),
      readInterviewStaffing: (personId) =>
        readInterviewStaffing(personId).pipe(Effect.provideService(Database, database)),
      authorizeMaintenance: (command, personId) =>
        authorizeMaintenance(command, personId).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Profile, profile),
        ),
      maintainRecruitment: (command, personId) =>
        maintainRecruitment(command, personId).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Profile, profile),
        ),
      readAssignmentBoard: (query, context) =>
        readAssignmentBoard(query, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, profile),
        ),
      assignApplicant: (command, context) =>
        assignApplicant(command, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, profile),
        ),
      readSchedulingBoard: (context) =>
        readSchedulingBoard(context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, profile),
        ),
      scheduleInterview: (command, context) =>
        scheduleInterview(command, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Organization, organization),
          Effect.provideService(Profile, profile),
        ),
      readInvitationResponse: (capability) =>
        readInvitationResponse(capability).pipe(Effect.provideService(Database, database)),
      confirmInvitation: (capability, context) =>
        confirmInvitation(capability, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Profile, profile),
        ),
      rejectInvitation: (capability, input, context) =>
        rejectInvitation(capability, input, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Profile, profile),
        ),
      readInterviewConduct: (interviewId, context) =>
        readInterviewConduct(interviewId, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Organization, organization),
        ),
      finalizeInterview: (command, context) =>
        finalizeInterview(command, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Organization, organization),
        ),
      cancelInterview: (command, context) =>
        cancelInterview(command, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
      correctInterviewAssessment: (command, context) =>
        correctInterviewAssessment(command, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Organization, organization),
        ),
      requestNewInvitationTime: (capability, input, context) =>
        requestNewInvitationTime(capability, input, context).pipe(
          Effect.provideService(Database, database),
          Effect.provideService(Admissions, admissions),
          Effect.provideService(Profile, profile),
        ),
    });
  }),
);
