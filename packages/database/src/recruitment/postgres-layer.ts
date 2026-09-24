import { Effect, Layer } from "effect";
import { Admissions } from "@vektorprogrammet/domain/admissions";
import { Database } from "../service.js";
import { Organization } from "@vektorprogrammet/domain/organization";
import { Profile } from "@vektorprogrammet/domain/profile";
import { assignApplicant, readAssignmentBoard } from "./postgres.js";
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

/** Live Recruitment authority; all supporting capabilities remain explicit. */
export const RecruitmentLive = Layer.effect(
  Recruitment,
  Effect.gen(function* () {
    const database = yield* Database;
    const admissions = yield* Admissions;
    const organization = yield* Organization;
    const profile = yield* Profile;

    return Recruitment.of({
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
