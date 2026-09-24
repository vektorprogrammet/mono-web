import { PersonId } from "./schema.js";
import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  OrganizationLifecycleCommand,
  Appointment,
  appointmentStateAt,
  transitionAppointment,
} from "./lifecycle.js";

const current = Schema.decodeUnknownSync(Appointment)({
  appointmentId: "appointment-1",
  personId: PersonId.make("person-1"),
  target: { kind: "Team", id: "team-1" },
  position: "Leder",
  leadership: true,
  startAt: "2026-08-01T00:00:00Z",
  endAt: null,
  suspended: false,
  revision: 3,
  state: "Current",
});

const now = "2026-09-24T11:00:00Z";

const common = {
  commandId: "command-1",
  reason: "Handover",
  appointmentId: current.appointmentId,
  expectedRevision: 3,
};

it("projects half-open effective intervals by instant rather than timezone spelling", () => {
  expect(appointmentStateAt({ ...current, endAt: "2026-09-24T12:00:00+02:00" }, now)).toBe("Ended");
  expect(appointmentStateAt({ ...current, endAt: now }, now)).toBe("Ended");
  expect(appointmentStateAt({ ...current, startAt: "2026-09-24T14:00:00+02:00" }, now)).toBe(
    "Future",
  );
  expect(appointmentStateAt({ ...current, suspended: true, endAt: now }, now)).toBe("Ended");

  const ended = transitionAppointment(
    { ...current, suspended: true },
    OrganizationLifecycleCommand.cases.EndAppointment.make({ ...common, endAt: now }),
    current.appointmentId,
    now,
  );

  expect(Result.getOrThrow(ended)).toEqual({
    ...current,
    suspended: true,
    endAt: now,
    state: "Ended",
    revision: 4,
  });
});

it("rejects stale and invalid revisions without changing the appointment", () => {
  {
    const observedTaggedValue = transitionAppointment(
      current,
      OrganizationLifecycleCommand.cases.EndAppointment.make({
        ...common,
        expectedRevision: 2,
        endAt: now,
      }),
      current.appointmentId,
      now,
    );

    expect(observedTaggedValue).toHaveProperty(["_tag"], "Failure");
    expect(observedTaggedValue).toMatchObject({ failure: { code: "Stale" } });
  }

  {
    const observedTaggedValue = transitionAppointment(
      current,
      OrganizationLifecycleCommand.cases.EndAppointment.make({ ...common, endAt: current.startAt }),
      current.appointmentId,
      now,
    );

    expect(observedTaggedValue).toHaveProperty(["_tag"], "Failure");
    expect(observedTaggedValue).toMatchObject({ failure: { code: "Invalid" } });
  }

  expect(current.endAt).toBeNull();
});

it("preserves identity, interval, and title through suspension and reinstatement", () => {
  const suspended = transitionAppointment(
    current,
    OrganizationLifecycleCommand.cases.SuspendAppointment.make({ ...common }),
    current.appointmentId,
    now,
  );

  const restored = transitionAppointment(
    Result.getOrThrow(suspended),
    OrganizationLifecycleCommand.cases.ReinstateAppointment.make({
      ...common,
      expectedRevision: 4,
    }),
    current.appointmentId,
    now,
  );

  expect(Result.getOrThrow(restored)).toEqual({ ...current, revision: 5 });
});

it("can clear an operational title and denies national local-leader authority", () => {
  const revised = transitionAppointment(
    current,
    OrganizationLifecycleCommand.cases.ReviseAppointment.make({
      ...common,
      position: null,
      leadership: false,
      startAt: current.startAt,
      endAt: null,
    }),
    current.appointmentId,
    now,
  );

  expect(Result.getOrThrow(revised)).toEqual({
    ...current,
    position: null,
    leadership: false,
    revision: 4,
  });
  {
    const observedTaggedValue = transitionAppointment(
      undefined,
      OrganizationLifecycleCommand.cases.Appoint.make({
        commandId: "national",
        reason: "Appointment",
        personId: current.personId,
        target: { kind: "NationalBoard", id: "board" },
        position: "Chair",
        leadership: true,
        startAt: current.startAt,
        endAt: null,
      }),
      "national",
      now,
    );

    expect(observedTaggedValue).toHaveProperty(["_tag"], "Failure");
    expect(observedTaggedValue).toMatchObject({ failure: { code: "Invalid" } });
  }
});

it("rejects a blank audit reason before a lifecycle command can execute", () => {
  const decode = Schema.decodeUnknownSync(OrganizationLifecycleCommand);

  const command = OrganizationLifecycleCommand.cases.CreateNationalBoard.make({
    commandId: "board-command",
    name: "National board",
    reason: "Appoint national board",
  });

  expect(() => decode({ ...command, reason: " " })).toThrow();
});
