import { SocialEventId, SocialEventObservedAt } from "@vektorprogrammet/domain/social-events";
import { DepartmentId, SemesterId } from "@vektorprogrammet/domain/organization";
import { IdempotencyKey } from "@vektorprogrammet/http-api";
import { describe, expect, it } from "vitest";
import type { SocialEventsCommandFactories } from "./command";
import { LoadedList, LoadedScope, SubmittedCreate, SucceededCreate } from "./message";
import { makeInitialModel } from "./model";
import { makeUpdate } from "./update";
import { timeLabel } from "./view";

const issued: Array<string> = [];
const commands: SocialEventsCommandFactories = {
  LoadScope: ({ requestId }) => {
    issued.push(`scope:${requestId}`);
    return { name: "LoadSocialEventsScope", args: { requestId }, effect: undefined as never };
  },
  LoadList: ({ requestId }) => {
    issued.push(`list:${requestId}`);
    return { name: "LoadSocialEventsList", args: { requestId }, effect: undefined as never };
  },
  Create: ({ requestId }) => {
    issued.push(`create:${requestId}`);
    return { name: "CreateSocialEvent", args: { requestId }, effect: undefined as never };
  },
};
const update = makeUpdate(commands);

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
    const scoped = update(makeInitialModel(), LoadedScope({ requestId: 1, scope }));
    expect(scoped[0].list._tag).toBe("Loading");
    expect(issued).toEqual(["list:2"]);

    const loaded = update(scoped[0], LoadedList({ requestId: 2, list: emptyList }));
    const submitted = update(
      {
        ...loaded[0],
        draft: {
          ...loaded[0].draft,
          title: "Vintertreff",
          description: "Alle samles.",
          startAt: "2030-01-02T13:00",
          endAt: "2030-01-02T15:00",
        },
      },
      SubmittedCreate({ commandId: IdempotencyKey.make("AAAAAAAAAAAAAAAAAAAAAA") }),
    );
    expect(submitted[0].pendingCommand).toBe("Create");

    const afterCreate = update(submitted[0], SucceededCreate({ requestId: 3 }));
    expect(afterCreate[0].pendingCommand).toBeNull();
    expect(afterCreate[0].success).toBe(true);
    expect(afterCreate[0].list._tag).toBe("Loading");
    expect(issued).toEqual(["list:2", "create:3", "list:4"]);

    const afterList = update(afterCreate[0], LoadedList({ requestId: 4, list: listedEvent }));
    expect(afterList[0].list).toEqual({ _tag: "Success", data: listedEvent });
  });

  it("does not submit a create while the selected scope is still loading", () => {
    issued.length = 0;
    const scoped = update(makeInitialModel(), LoadedScope({ requestId: 1, scope }));
    const submitted = update(
      {
        ...scoped[0],
        draft: {
          ...scoped[0].draft,
          title: "Vintertreff",
          description: "Alle samles.",
          startAt: "2030-01-02T13:00",
          endAt: "2030-01-02T15:00",
        },
      },
      SubmittedCreate({ commandId: IdempotencyKey.make("BBBBBBBBBBBBBBBBBBBBBB") }),
    );

    expect(submitted[0]).toEqual({
      ...scoped[0],
      draft: {
        ...scoped[0].draft,
        title: "Vintertreff",
        description: "Alle samles.",
        startAt: "2030-01-02T13:00",
        endAt: "2030-01-02T15:00",
      },
    });
    expect(issued).toEqual(["list:2"]);
    expect(submitted[1]).toEqual([]);
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
