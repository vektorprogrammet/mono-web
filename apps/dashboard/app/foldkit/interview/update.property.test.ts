import { expect, it } from "@effect/vitest";
import type { EffectSdk } from "@vektorprogrammet/sdk/effect";
import { Schema } from "effect";
import * as fc from "effect/testing/FastCheck";
import { makeInterviewCommands } from "./command";
import {
  AcceptedCandidate,
  Message,
  SelectedDepartment,
  SelectedSemester,
  SubmittedSchedule,
} from "./message";
import { CandidateData, Model, makeInitialModel } from "./model";
import { makeUpdate } from "./update";

const propertyOptions = {
  fastCheck: { seed: 26082028, numRuns: 150 },
} as const;

const update = makeUpdate(makeInterviewCommands({} as EffectSdk, null));

it.prop(
  "every generated model and message returns a valid model",
  {
    model: Schema.toArbitrary(Model)(fc),
    message: Schema.toArbitrary(Message)(fc),
  },
  ({ model, message }) => {
    const [next] = update(model, message);
    expect(() => Schema.decodeUnknownSync(Model)(next)).not.toThrow();
  },
  propertyOptions,
);

it.prop(
  "schedule submission without a selected interview emits no command",
  {
    departmentId: fc.string(),
    semesterId: fc.string(),
    interviewTime: fc.string(),
    room: fc.string(),
    campus: fc.string(),
  },
  ({ departmentId, semesterId, interviewTime, room, campus }) => {
    const model = {
      ...makeInitialModel("dashboard"),
      departmentId,
      semesterId,
      interviewTime: { _tag: "NotValidated" as const, value: interviewTime },
      room: { _tag: "NotValidated" as const, value: room },
      campus: { _tag: "NotValidated" as const, value: campus },
      selectedInterviewId: null,
    };
    const [next, commands] = update(model, SubmittedSchedule());
    expect(next).toBe(model);
    expect(commands).toHaveLength(0);
  },
  propertyOptions,
);

it.prop(
  "pending scheduling suppresses duplicate schedule commands",
  {
    interviewId: fc.string({ minLength: 1 }),
    departmentId: fc.string({ minLength: 1 }),
    semesterId: fc.string({ minLength: 1 }),
  },
  ({ interviewId, departmentId, semesterId }) => {
    const model = {
      ...makeInitialModel("dashboard"),
      departmentId,
      semesterId,
      selectedInterviewId: interviewId,
      isScheduling: true,
    };
    const [next, commands] = update(model, SubmittedSchedule());
    expect(next).toBe(model);
    expect(commands).toHaveLength(0);
  },
  propertyOptions,
);

it.prop(
  "context changes clear the selected interview",
  {
    interviewId: fc.string({ minLength: 1 }),
    departmentId: fc.string(),
    semesterId: fc.string(),
  },
  ({ interviewId, departmentId, semesterId }) => {
    const model = { ...makeInitialModel("dashboard"), selectedInterviewId: interviewId };
    const [afterDepartment] = update(model, SelectedDepartment({ value: departmentId }));
    const [afterSemester] = update(model, SelectedSemester({ value: semesterId }));
    expect(afterDepartment.selectedInterviewId).toBeNull();
    expect(afterSemester.selectedInterviewId).toBeNull();
  },
  propertyOptions,
);

it.prop(
  "pending candidate acceptance suppresses duplicate accept commands",
  {
    feedback: fc.option(fc.string(), { nil: null }),
    interviewTime: fc.string(),
    room: fc.string(),
    campus: fc.string(),
  },
  ({ feedback, interviewTime, room, campus }) => {
    const model = {
      ...makeInitialModel("candidate"),
      candidate: CandidateData.Success({
        data: { schedulingStatus: "pending" as const, interviewTime, room, campus },
      }),
      isAccepting: true,
      feedback,
    };
    const [next, commands] = update(model, AcceptedCandidate());
    expect(next).toBe(model);
    expect(commands).toHaveLength(0);
  },
  propertyOptions,
);
