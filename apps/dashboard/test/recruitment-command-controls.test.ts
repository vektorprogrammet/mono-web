// @vitest-environment happy-dom
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { vi } from "vitest";
import { RecruitmentMaintenanceCommand, RecruitmentInterviewResource, StrongETag } from "@vektorprogrammet/http-api";
import { commandsFor as recruitmentCommands } from "../app/foldkit/recruitment/command";
import { commandsFor as invitationCommands } from "../app/foldkit/interview/command";
import { commandsFor as schedulingCommands } from "../app/foldkit/scheduling/command";
import { commandsFor as maintenanceCommands } from "../app/foldkit/recruitment-maintenance/command";
import type { RecruitmentClient } from "../app/foldkit/recruitment/browser-client";
import type { InvitationResponseClient } from "../app/foldkit/interview/browser-client";
import {
  CreateApplicationInterviewInputSchema, ScheduleInterviewInputSchema, FinalizeInterviewInputSchema,
  CorrectInterviewAssessmentInputSchema, CancelInterviewInputSchema, RecruitmentAssignmentBoardSchema,
} from "../app/foldkit/recruitment/bridge";
import { InvitationResponseResourceSchema } from "../app/foldkit/interview/bridge";
import { SucceededAssignment } from "../app/foldkit/recruitment/message";
import { SucceededInvitationResponse } from "../app/foldkit/interview/message";
import { FailedSave, RetriedMaintenance } from "../app/foldkit/recruitment-maintenance/message";
import { Mutation, init as initMaintenance } from "../app/foldkit/recruitment-maintenance/model";
import { updateFor as maintenanceUpdate } from "../app/foldkit/recruitment-maintenance/update";

// These controls need valid inputs, not random generation. Opaque HTTP filters
// exhaust generic sampling before the command assertions can run.
const decodeInputs = Schema.decodeUnknownEffect(Schema.Struct({
  assignment: CreateApplicationInterviewInputSchema,
  schedule: ScheduleInterviewInputSchema,
  finalize: FinalizeInterviewInputSchema,
  correction: CorrectInterviewAssessmentInputSchema,
  cancel: CancelInterviewInputSchema,
  maintenance: RecruitmentMaintenanceCommand,
  assigned: RecruitmentInterviewResource,
}));

const board = Schema.decodeSync(RecruitmentAssignmentBoardSchema)({
  admissionPeriodId: "period-controls", departmentId: "department-controls",
  candidates: [], interviewers: [], interviewSchemas: [],
});

const etag = StrongETag.make(`"vkr2.${"A".repeat(43)}"`);

const inputHeaders = { "idempotency-key": "controls-command-identity-0029", "if-match": etag };

const inputParams = { interviewId: "interview-controls" };

const assessment = {
  answers: [{ questionId: "question-controls", answer: "A considered answer" }],
  score: { explanatoryPower: 7, roleModel: 8, suitability: 9 },
  recommendation: "Ja",
};

const inputsFixture = {
  assignment: {
    params: { applicationId: "application-controls" }, headers: inputHeaders,
    payload: { interviewerPersonId: "person-controls", interviewSchemaId: "schema-controls" },
  },
  schedule: {
    params: inputParams, headers: inputHeaders,
    payload: { scheduledAt: "2031-09-20T13:30:00.000Z", room: "Room", campus: "Campus",
      mapLink: null, message: "Please attend the interview" },
  },
  finalize: { params: inputParams, headers: inputHeaders, payload: assessment },
  correction: { params: inputParams, headers: inputHeaders, payload: { ...assessment, expectedRevision: 1 } },
  cancel: { params: inputParams, headers: inputHeaders, payload: {} },
  maintenance: RecruitmentMaintenanceCommand.cases.ChangeInterviewStaffing.make({
    commandId: inputHeaders["idempotency-key"], reason: "Correct the interviewer assignment",
    interviewId: RecruitmentMaintenanceCommand.cases.ChangeInterviewStaffing.fields.interviewId.make(inputParams.interviewId),
    expectedRevision: 1,
    interviewerPersonId: RecruitmentMaintenanceCommand.cases.ChangeInterviewStaffing.fields.interviewerPersonId.make("person-controls"),
    coInterviewerPersonId: null,
  }),
  assigned: {
    ...inputParams, applicationId: "application-controls", departmentId: "department-controls",
    interviewerPersonId: "person-controls", coInterviewerPersonId: null,
    interviewSchemaId: "schema-controls", assignedByPersonId: "coordinator-controls",
    assignedAt: "2031-09-19T12:00:00.000Z", revision: 1,
  },
};

// Schema failures carry a useful message; the former plain SampleError did not.
const controlInputs = decodeInputs(inputsFixture).pipe(
  Effect.tapError((error) => Effect.sync(() => assert.fail(
    "Invalid command-control fixture: " + error.message,
  ))),
);

const invitation = Schema.decodeSync(InvitationResponseResourceSchema)({
  observation: { scheduledAt: "2031-09-20T13:30:00.000Z", room: "Room", campus: "Campus",
    responseState: "Accepted", responseMessage: null }, etag,
});

it.effect("all fifteen handwritten Commands construct and discard without client calls, fetch or UUID creation", () =>
  Effect.gen(function* () {
    const inputs = yield* controlInputs;
    assert.isDefined(inputs);
    let calls = 0;

    const unexpected = () => {
      calls++;

      return Effect.die("discarded Command called its client");
    };

    const client: RecruitmentClient = { recruitment: {
      readAssignmentBoard: unexpected, createApplicationInterview: unexpected,
      readSchedulingBoard: unexpected, scheduleInterview: unexpected, readInterviewConduct: unexpected,
      finalizeInterview: unexpected, correctInterviewAssessment: unexpected, cancelInterview: unexpected,
    } };

    const applicant: InvitationResponseClient = { recruitment: {
      readInvitationResponse: unexpected, confirmInvitation: unexpected,
      rejectInvitation: unexpected, requestNewInvitationTime: unexpected,
    } };

    const { fetch, uuid } = yield* Effect.acquireRelease(
      Effect.sync(() => {
        vi.stubGlobal("location", new URL("http://localhost:3000"));
        vi.stubEnv("VITE_API_URL", "http://localhost:3000");

        return { fetch: vi.spyOn(globalThis, "fetch"), uuid: vi.spyOn(globalThis.crypto, "randomUUID") };
      }),
      ({ fetch, uuid }) => Effect.sync(() => { fetch.mockRestore(); uuid.mockRestore(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }),
    );

    const recruitment = recruitmentCommands(client);
    const interview = invitationCommands(applicant);
    const scheduling = schedulingCommands(client);
    const maintenance = maintenanceCommands();
    const interviewId = inputs.schedule.params.interviewId;
    const correlation = { requestId: 17, generation: 3, interviewId };

    const discarded = [
      recruitment.LoadAssignmentBoard({ requestId: 17, status: "all" }),
      recruitment.CreateApplicationInterview({ input: inputs.assignment, status: "all" }),
      interview.ReadInvitationResponse({ requestId: 17 }),
      interview.ConfirmInvitation({ requestId: 17, etag }),
      interview.RejectInvitation({ requestId: 17, etag, message: null }),
      interview.RequestNewInvitationTime({ requestId: 17, etag, message: "Another time" }),
      scheduling.LoadSchedulingBoard({ requestId: 17 }),
      scheduling.ScheduleInterview({ requestId: 17, input: inputs.schedule }),
      scheduling.ReadInterviewConduct(correlation),
      scheduling.FinalizeInterview({ ...correlation, input: inputs.finalize }),
      scheduling.CorrectInterviewAssessment({ ...correlation, input: inputs.correction }),
      scheduling.CancelInterview({ ...correlation, input: inputs.cancel }),
      maintenance.Load({ mode: "Questionnaires", requestId: 17 }),
      maintenance.Save({ command: inputs.maintenance }),
      maintenance.PrepareEdit(),
    ];

    assert.strictEqual(discarded.length, 15);
    assert.strictEqual(calls, 0);
    assert.strictEqual(fetch.mock.calls.length, 0);
    assert.strictEqual(uuid.mock.calls.length, 0);
  }),
);

it.effect("assignment success waits for mutation and fresh board instead of dispatching a premature SDK result", () =>
  Effect.gen(function* () {
    const inputs = yield* controlInputs;
    const mutationStarted = yield* Deferred.make<void>();
    const mutated = yield* Deferred.make<typeof inputs.assigned>();
    const readStarted = yield* Deferred.make<void>();
    const fresh = yield* Deferred.make<typeof board>();

    const commands = recruitmentCommands({ recruitment: {
      createApplicationInterview: () => Deferred.succeed(mutationStarted, undefined).pipe(Effect.andThen(Deferred.await(mutated))),
      readAssignmentBoard: () => Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(fresh))),
    } });

    const fiber = yield* Effect.forkChild(commands.CreateApplicationInterview({ input: inputs.assignment, status: "all" }).effect);
    yield* Deferred.await(mutationStarted);
    assert.isFalse(yield* Deferred.isDone(readStarted));
    yield* Deferred.succeed(mutated, inputs.assigned);
    yield* Deferred.await(readStarted);
    yield* Deferred.succeed(fresh, board);
    const message = yield* Fiber.join(fiber);
    assert.deepStrictEqual(message, SucceededAssignment({ board }));
  }),
);

it.effect("invitation compound success keeps request/action correlation and waits for the fresh observation", () =>
  Effect.gen(function* () {
    const accepted = yield* Deferred.make<void>();
    const mutationStarted = yield* Deferred.make<void>();
    const readStarted = yield* Deferred.make<void>();
    const fresh = yield* Deferred.make<typeof invitation>();

    const client: InvitationResponseClient = { recruitment: {
      confirmInvitation: () => Deferred.succeed(mutationStarted, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      readInvitationResponse: () => Deferred.succeed(readStarted, undefined).pipe(Effect.andThen(Deferred.await(fresh))),
      rejectInvitation: () => Effect.die("not the selected action"),
      requestNewInvitationTime: () => Effect.die("not the selected action"),
    } };

    const command = invitationCommands(client).ConfirmInvitation({ requestId: 17, etag });
    const fiber = yield* Effect.forkChild(command.effect);
    yield* Deferred.await(mutationStarted);
    assert.isFalse(yield* Deferred.isDone(readStarted));
    yield* Deferred.succeed(accepted, undefined);
    yield* Deferred.await(readStarted);
    yield* Deferred.succeed(fresh, invitation);
    const message = yield* Fiber.join(fiber);
    assert.deepStrictEqual(message, SucceededInvitationResponse({ requestId: 17,
      action: "Confirm", observation: invitation.observation, etag }));
  }),
);

it.effect("maintenance drops wrong-commandId failures and retries the identical owned command", () =>
  Effect.gen(function* () {
    const inputs = yield* controlInputs;
    yield* Effect.acquireRelease(
      Effect.sync(() => { vi.stubGlobal("location", new URL("http://localhost:3000")); vi.stubEnv("VITE_API_URL", "http://localhost:3000"); }),
      () => Effect.sync(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }),
    );
    const update = maintenanceUpdate(maintenanceCommands());

    const pending = { ...initMaintenance("Questionnaires"),
      status: "Ready" as const,
      mutation: Mutation.cases.Pending.make({ command: inputs.maintenance }),
    };

    const stale = update(pending, FailedSave({ commandId: inputs.maintenance.commandId + "-stale", message: "unconfirmed", conflict: false }));
    assert.strictEqual(stale.model, pending);
    assert.deepStrictEqual(stale.commands, []);
    const failed = update(pending, FailedSave({ commandId: inputs.maintenance.commandId, message: "unconfirmed", conflict: false }));
    const retry = update(failed.model, RetriedMaintenance());
    assert.strictEqual(retry.commands?.length, 1);
    assert.strictEqual(retry.commands?.[0]?.args?.command, inputs.maintenance);
    assert.deepStrictEqual(retry.model.mutation, Mutation.cases.Pending.make({ command: inputs.maintenance }));
  }),
);

