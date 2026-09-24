import { Effect } from "effect";
import { SocialEventId, SocialEventObservedAt } from "@vektorprogrammet/http-api"
import { DepartmentId, SemesterId } from "@vektorprogrammet/http-api"
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import type { SocialEventsCommandFactories } from "./command";
import { LoadedList, LoadedScope, SubmittedCreate, SucceededCreate } from "./message";
import { ListState, init } from "./model";
import { updateFor } from "./update";
import { timeLabel } from "./view";

const issued: Array<string> = [];

const commands: SocialEventsCommandFactories = {
  LoadScope: ({ requestId }) => {
    issued.push(`scope:${requestId}`);

    return { name: "LoadSocialEventsScope", args: { requestId }, effect: Effect.die("Transition tests must not execute commands") };
  },
  LoadList: ({ requestId }) => {
    issued.push(`list:${requestId}`);

    return { name: "LoadSocialEventsList", args: { requestId }, effect: Effect.die("Transition tests must not execute commands") };
  },
  Create: ({ requestId }) => {
    issued.push(`create:${requestId}`);

    return { name: "CreateSocialEvent", args: { requestId }, effect: Effect.die("Transition tests must not execute commands") };
  },
};

const update = updateFor(commands);

const departmentId = DepartmentId.make("department-a");

const semesterId = SemesterId.make("semester-a");

const observedAt = SocialEventObservedAt.make("2030-01-01T12:00:00.000Z");

const scope = {
  observedAt,
  departments: [{ departmentId, name: "Trondheim" }],
  semesters: [
    {
      semesterId,
      startAt: "2030-01-01T00:00:00.000Z",
      endAt: "2030-06-30T23:59:59.000Z",
    },
  ],
} as const;

const emptyList = {
  observedAt,
  departmentId,
  semesterId,
  events: [],
} as const;

const listedEvent = {
  ...emptyList,
  events: [
    {
      eventId: SocialEventId.make("event-a"),
      revision: 0,
      departmentId,
      semesterId,
      audience: "TeamMembers",
      title: "Vintertreff",
      description: "Alle samles.",
      link: null,
      startAt: "2030-01-02T12:00:00.000Z",
      endAt: "2030-01-02T14:00:00.000Z",
    },
  ],
} as const;

describe("social-event Foldkit transitions", () => {
  it("reloads the scoped list after create without inserting the create response", () => {
    issued.length = 0;
    const scoped = update(init(), LoadedScope({ requestId: 1, scope }));
    expect(scoped.model.list._tag).toBe("Loading");
    expect(issued).toEqual(["list:2"]);

    const loaded = update(scoped.model, LoadedList({ requestId: 2, list: emptyList }));

    const submitted = update(
      {
        ...loaded.model,
        draft: {
          ...loaded.model.draft,
          title: "Vintertreff",
          description: "Alle samles.",
          startAt: "2030-01-02T13:00",
          endAt: "2030-01-02T15:00",
        },
      },
      SubmittedCreate({ commandId: IdempotencyKey.make("AAAAAAAAAAAAAAAAAAAAAA") }),
    );

    expect(submitted.model.pendingCommand).toBe("Create");

    const afterCreate = update(submitted.model, SucceededCreate({ requestId: 3 }));
    expect(afterCreate.model.pendingCommand).toBeNull();
    expect(afterCreate.model.success).toBe(true);
    expect(afterCreate.model.list._tag).toBe("Loading");
    expect(issued).toEqual(["list:2", "create:3", "list:4"]);

    const afterList = update(afterCreate.model, LoadedList({ requestId: 4, list: listedEvent }));
    expect(afterList.model.list).toEqual(ListState.cases.Success.make({ data: listedEvent }));
  });

  it("does not submit a create while the selected scope is still loading", () => {
    issued.length = 0;
    const scoped = update(init(), LoadedScope({ requestId: 1, scope }));

    const submitted = update(
      {
        ...scoped.model,
        draft: {
          ...scoped.model.draft,
          title: "Vintertreff",
          description: "Alle samles.",
          startAt: "2030-01-02T13:00",
          endAt: "2030-01-02T15:00",
        },
      },
      SubmittedCreate({ commandId: IdempotencyKey.make("BBBBBBBBBBBBBBBBBBBBBB") }),
    );

    expect(submitted.model).toEqual({
      ...scoped.model,
      draft: {
        ...scoped.model.draft,
        title: "Vintertreff",
        description: "Alle samles.",
        startAt: "2030-01-02T13:00",
        endAt: "2030-01-02T15:00",
      },
    });
    expect(issued).toEqual(["list:2"]);
    expect(submitted.commands).toEqual([]);
  });

  it("uses the frozen half-open observedAt label boundaries", () => {
    const observedAt = "2030-01-01T12:00:00.000Z";
    const observed = new Date(observedAt).getTime();
    const week = 7 * 24 * 60 * 60 * 1000;

    expect(timeLabel(new Date(observed - 1).toISOString(), observedAt)).toBe("Har vært");
    expect(timeLabel(new Date(observed).toISOString(), observedAt)).toBe("Skjer innen en uke");
    expect(timeLabel(new Date(observed + week - 1).toISOString(), observedAt)).toBe(
      "Skjer innen en uke",
    );
    expect(timeLabel(new Date(observed + week).toISOString(), observedAt)).toBeNull();
    expect(timeLabel(new Date(observed + week + 1).toISOString(), observedAt)).toBeNull();
  });
});
