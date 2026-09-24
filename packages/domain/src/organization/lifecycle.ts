import { Match, Result, Schema } from "effect";
import { AccountAccess } from "../identity/access.js";
import { compareRfc3339Instants, Rfc3339InstantSchema } from "../time.js";
import { PersonId } from "./schema.js";

const Text = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(250), Schema.isPattern(/\S/)),
);

const Revision = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));

export const AppointmentTarget = Schema.Struct({
  kind: Schema.Literals(["Team", "NationalBoard"]),
  id: Text,
});

export const Appointment = Schema.Struct({
  appointmentId: Text,
  personId: PersonId,
  target: AppointmentTarget,
  position: Schema.NullOr(Text),
  leadership: Schema.Boolean,
  startAt: Rfc3339InstantSchema,
  endAt: Schema.NullOr(Rfc3339InstantSchema),
  suspended: Schema.Boolean,
  revision: Revision,
  state: Schema.Literals(["Current", "Future", "Ended"]),
});

export type Appointment = typeof Appointment.Type;

export const AppointmentHistory = Schema.Struct({
  commandId: Text,
  action: Text,
  subjectId: Text,
  actorPersonId: PersonId,
  occurredAt: Rfc3339InstantSchema,
  reason: Text,
  before: Schema.NullOr(Schema.Union([Appointment, AccountAccess])),
  after: Schema.NullOr(Schema.Union([Appointment, AccountAccess])),
});

export const AppointmentManagement = Schema.Struct({
  globalAdministrator: Schema.Boolean,
  people: Schema.Array(Schema.Struct({ personId: PersonId, name: Text })),
  units: Schema.Array(
    Schema.Struct({
      target: AppointmentTarget,
      name: Text,
      departmentId: Schema.NullOr(Text),
    }),
  ),
  appointments: Schema.Array(Appointment),
  accounts: Schema.Array(AccountAccess),
  history: Schema.Array(AppointmentHistory),
});

export type AppointmentManagement = typeof AppointmentManagement.Type;

const command = { commandId: Text, reason: Text };

const mutable = {
  position: Schema.NullOr(Text),
  leadership: Schema.Boolean,
  startAt: Rfc3339InstantSchema,
  endAt: Schema.NullOr(Rfc3339InstantSchema),
};

const existing = { ...command, appointmentId: Text, expectedRevision: Revision };

export const OrganizationLifecycleCommand = Schema.TaggedUnion({
  Appoint: {
    ...command,
    personId: PersonId,
    target: AppointmentTarget,
    ...mutable,
  },
  ReviseAppointment: {
    ...existing,
    ...mutable,
  },
  EndAppointment: {
    ...existing,
    endAt: Rfc3339InstantSchema,
  },
  SuspendAppointment: {
    ...existing,
  },
  ReinstateAppointment: {
    ...existing,
  },
  CreateNationalBoard: {
    ...command,
    name: Text,
  },
  ChangeAccountAccess: {
    ...command,
    personId: PersonId,
    expectedRevision: Revision,
    disabled: Schema.Boolean,
  },
});

export type OrganizationLifecycleCommand = typeof OrganizationLifecycleCommand.Type;

export const OrganizationLifecycleResult = Schema.Struct({
  commandId: Text,
  subjectId: Text,
  revision: Revision,
});

export type OrganizationLifecycleResult = typeof OrganizationLifecycleResult.Type;

export class OrganizationLifecycleFailure extends Schema.TaggedError<OrganizationLifecycleFailure>()(
  "OrganizationLifecycleFailure",
  {
    code: Schema.Literals([
      "Denied",
      "NotFound",
      "Stale",
      "Conflict",
      "Invalid",
      "SelfDisable",
      "LastAdministrator",
      "Unavailable",
    ]),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** Temporal validity is derived; suspension is an independent persisted state. */
export const appointmentStateAt = (
  appointment: Pick<Appointment, "suspended" | "startAt" | "endAt">,
  now: string,
): Appointment["state"] =>
  appointment.endAt !== null && compareRfc3339Instants(appointment.endAt, now) <= 0
    ? "Ended"
    : compareRfc3339Instants(appointment.startAt, now) > 0
      ? "Future"
      : "Current";

export type AppointmentCommand = Exclude<
  OrganizationLifecycleCommand,
  { readonly _tag: "CreateNationalBoard" | "ChangeAccountAccess" }
>;

export class AppointmentTransitionFailure extends Schema.TaggedError<AppointmentTransitionFailure>()(
  "AppointmentTransitionFailure",
  {
    code: Schema.Literals(["NotFound", "Stale", "Invalid"]),
  },
) {}

/** One exhaustive machine owns all appointment state transitions. */
export const transitionAppointment = (
  current: Appointment | undefined,
  command: AppointmentCommand,
  appointmentId: string,
  now: string,
): Result.Result<Appointment, AppointmentTransitionFailure> =>
  Match.value(command).pipe(
    Match.withReturnType<Result.Result<Appointment, AppointmentTransitionFailure>>(),
    Match.tag("Appoint", (command) =>
      current
        ? Result.fail(new AppointmentTransitionFailure({ code: "Invalid" }))
        : Result.succeed({
            appointmentId,
            personId: command.personId,
            target: command.target,
            position: command.position,
            leadership: command.leadership,
            startAt: command.startAt,
            endAt: command.endAt,
            suspended: false,
            revision: 0,
            state: "Future",
          }),
    ),
    Match.orElse((command) => {
      if (!current) return Result.fail(new AppointmentTransitionFailure({ code: "NotFound" }));

      if (current.revision !== command.expectedRevision)
        return Result.fail(new AppointmentTransitionFailure({ code: "Stale" }));

      return Match.value(command).pipe(
        Match.withReturnType<Result.Result<Appointment, AppointmentTransitionFailure>>(),
        Match.tag("ReviseAppointment", (command) =>
          Result.succeed({
            ...current,
            position: command.position,
            leadership: command.leadership,
            startAt: command.startAt,
            endAt: command.endAt,
            revision: current.revision + 1,
          }),
        ),
        Match.tag("EndAppointment", (command) =>
          current.endAt !== null && compareRfc3339Instants(current.endAt, now) <= 0
            ? Result.fail(new AppointmentTransitionFailure({ code: "Invalid" }))
            : Result.succeed({ ...current, endAt: command.endAt, revision: current.revision + 1 }),
        ),
        Match.tag("SuspendAppointment", () =>
          current.suspended
            ? Result.fail(new AppointmentTransitionFailure({ code: "Invalid" }))
            : Result.succeed({ ...current, suspended: true, revision: current.revision + 1 }),
        ),
        Match.tag("ReinstateAppointment", () =>
          !current.suspended
            ? Result.fail(new AppointmentTransitionFailure({ code: "Invalid" }))
            : Result.succeed({ ...current, suspended: false, revision: current.revision + 1 }),
        ),
        Match.exhaustive,
      );
    }),
    Result.flatMap((next) =>
      (next.endAt !== null && compareRfc3339Instants(next.endAt, next.startAt) <= 0) ||
      (next.target.kind === "NationalBoard" && next.leadership)
        ? Result.fail(new AppointmentTransitionFailure({ code: "Invalid" }))
        : Result.succeed({ ...next, state: appointmentStateAt(next, now) }),
    ),
  );
