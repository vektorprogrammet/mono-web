import { Dialog } from "@foldkit/ui";
import {
  IdempotencyKey,
  makeNativeProblem,
  TeamApplicationIntakeResource,
  TeamApplicationListResponse,
  TeamApplicationResource,
  type NativeProblemCode,
} from "@vektorprogrammet/http-api";
import { createEffectClient, type FetchCapability } from "@vektorprogrammet/sdk/effect";
import { Effect, Option, Predicate, Schema as S } from "effect";
import { AsyncData, type Update } from "foldkit";
import { describe, expect, it } from "vitest";
import { teamApplicationsOperations, type TeamApplicationsOperations } from "./browser-client";
import { commandsFor } from "./command";
import {
  ChangedDeadline,
  ClosedApplication,
  ConfirmedDelete,
  FailedLoadPage,
  GotDeleteDialogMessage,
  OpenedApplication,
  RequestedDelete,
  RequestedNextPage,
  RetriedPage,
  SubmittedIntake,
  SucceededLoadPage,
  SucceededReadApplication,
  SucceededReviseIntake,
  ToggledAcceptApplication,
  type Message,
} from "./message";
import { DetailData, init, PageData, TeamId, type Model } from "./model";
import { updateFor } from "./update";

const etag = (letter: string): string => `"vkr2.${letter.repeat(43)}"`;

const firstApplicationId = "0f8fad5b-d9cb-469f-a165-70867728950e";

const teamId = S.decodeSync(TeamId)("team-it");

const seed = IdempotencyKey.make("seed-0123456789abcdefghij");

const intake = (overrides: Partial<typeof TeamApplicationIntakeResource.Encoded> = {}) => ({
  acceptApplication: true,
  deadline: "2026-10-01T21:59:00.000Z",
  revision: 3,
  open: true,
  etag: etag("A"),
  ...overrides,
});

const listPage = (overrides: Partial<typeof TeamApplicationListResponse.Encoded> = {}) =>
  S.decodeSync(TeamApplicationListResponse)({
    teamId: "team-it",
    teamName: "IT",
    items: [
      {
        applicationId: firstApplicationId,
        name: "Ada Lovelace",
        submittedAt: "2026-09-20T10:00:00.000Z",
      },
    ],
    nextCursor: "Y3Vyc29y",
    intake: intake(),
    canManage: true,
    ...overrides,
  });

const application = S.decodeSync(TeamApplicationResource)({
  applicationId: firstApplicationId,
  teamId: "team-it",
  teamName: "IT",
  name: "Ada Lovelace",
  email: "ada@example.invalid",
  phone: "+47 900 00 000",
  yearOfStudy: "3. klasse",
  fieldOfStudy: "Datateknologi",
  biography: "Jeg studerer datateknologi.",
  motivation: "Jeg vil bidra til teamet.",
  submittedAt: "2026-09-20T10:00:00.000Z",
  canManage: true,
});

const inert: TeamApplicationsOperations = {
  listApplications: () => Effect.die("not executed by transition tests"),
  readApplication: () => Effect.die("not executed by transition tests"),
  deleteApplication: () => Effect.die("not executed by transition tests"),
  reviseIntake: () => Effect.die("not executed by transition tests"),
};

interface SentRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

/** The generated SDK over a recording fetch, so tests observe the exact wire request. */
const wire = (respond: () => Response) => {
  const sent: SentRequest[] = [];

  const fetch: FetchCapability = async (input, init) => {
    const request = new Request(String(input), init);
    sent.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    });

    return respond();
  };

  return {
    sent,
    operations: teamApplicationsOperations(
      createEffectClient("https://dashboard.test", { fetch })["team-applications"],
    ),
  };
};

const problem = (code: NativeProblemCode): Response => {
  const body = makeNativeProblem(code);

  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: {
      "Content-Type": "application/problem+json",
      "Cache-Control": "no-store",
      Vary: "Origin",
    },
  });
};

const loaded = (
  update: (model: Model, message: Message) => Update.Return<Model, Message>,
  page = listPage(),
): Model => update(init(teamId, seed), SucceededLoadPage({ requestId: 1, page })).model;

describe("team application workflow", () => {
  it("ignores responses that belong to superseded requests", () => {
    const update = updateFor(commandsFor(inert));
    const next = update(loaded(update), RequestedNextPage());

    expect(next.commands?.[0]).toMatchObject({
      name: "LoadTeamApplicationPage",
      args: { cursor: "Y3Vyc29y", requestId: 2 },
    });
    expect(
      update(
        next.model,
        SucceededLoadPage({ requestId: 1, page: listPage({ teamName: "Gammel" }) }),
      ).model,
    ).toBe(next.model);
    expect(update(next.model, FailedLoadPage({ requestId: 1, failure: "Denied" })).model).toBe(
      next.model,
    );

    const opened = update(
      next.model,
      OpenedApplication({ applicationId: application.applicationId }),
    ).model;

    const closed = update(opened, ClosedApplication()).model;

    expect(
      update(closed, SucceededReadApplication({ requestId: opened.detailRequestId, application }))
        .model,
    ).toBe(closed);
  });

  it("sends only the changed setting with the observed entity tag and reloads after a stale revision", async () => {
    const { sent, operations } = wire(() => problem("precondition.failed"));
    const update = updateFor(commandsFor(operations));
    const edited = update(loaded(update), ChangedDeadline({ value: "2026-10-25T03:00" })).model;
    const submitted = update(edited, SubmittedIntake());
    const outcome = await Effect.runPromise(submitted.commands![0]!.effect);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "PATCH",
      url: "https://dashboard.test/api/teams/team-it/application-intake",
    });
    expect(sent[0]!.headers.get("if-match")).toBe(etag("A"));
    expect(sent[0]!.headers.get("idempotency-key")).toBe(`${seed}-0`);
    expect(JSON.parse(sent[0]!.body)).toEqual({ deadline: "2026-10-25T02:00:00.000Z" });

    const stale = update(submitted.model, outcome);

    expect(stale.model.notice).toBe("Stale");
    expect(Predicate.isTagged(stale.model.mutation, "Idle")).toBe(true);
    expect(stale.commands?.map((command) => command.name)).toEqual(["LoadTeamApplicationPage"]);

    const newer = intake({
      acceptApplication: false,
      deadline: null,
      revision: 4,
      open: false,
      etag: etag("B"),
    });

    const refreshed = update(
      stale.model,
      SucceededLoadPage({
        requestId: stale.model.pageRequestId,
        page: listPage({ intake: newer }),
      }),
    ).model;

    expect(refreshed.intakeDraft).toEqual({
      basedOnEtag: etag("B"),
      acceptApplication: false,
      deadline: "",
    });
  });

  it("repeats an idempotency key only for the identical change after an unknown outcome", async () => {
    const { sent, operations } = wire(() => {
      throw new TypeError("network unavailable");
    });

    const update = updateFor(commandsFor(operations));

    const attempt = async (model: Model): Promise<Model> => {
      const submitted = update(model, SubmittedIntake());
      const outcome = await Effect.runPromise(submitted.commands![0]!.effect);

      return update(submitted.model, outcome).model;
    };

    const toggled = update(loaded(update), ToggledAcceptApplication({ isChecked: false })).model;
    const unknown = await attempt(toggled);

    expect(unknown.notice).toBe("Unavailable");
    const retried = await attempt(unknown);
    await attempt(update(retried, ChangedDeadline({ value: "2026-11-01T12:00" })).model);

    expect(sent.map((request) => request.headers.get("idempotency-key"))).toEqual([
      `${seed}-0`,
      `${seed}-0`,
      `${seed}-1`,
    ]);
    expect(sent.map((request) => JSON.parse(request.body))).toEqual([
      { acceptApplication: false },
      { acceptApplication: false },
      { acceptApplication: false, deadline: "2026-11-01T11:00:00.000Z" },
    ]);
  });

  it("refuses to send a deadline that the Oslo clock skips", () => {
    const update = updateFor(commandsFor(inert));
    const gap = update(loaded(update), ChangedDeadline({ value: "2026-03-29T02:30" })).model;
    const submitted = update(gap, SubmittedIntake());

    expect(Predicate.isTagged(submitted.model.mutation, "Idle")).toBe(true);
    expect(submitted.commands?.map((command) => command.name)).toEqual([
      "FocusTeamApplicationTarget",
    ]);
  });

  it("deletes once while the confirmation stays open, then drops the detail and reloads", async () => {
    const { sent, operations } = wire(
      () =>
        new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store", Vary: "Origin" },
        }),
    );

    const update = updateFor(commandsFor(operations));

    const opened = update(
      loaded(update),
      OpenedApplication({ applicationId: application.applicationId }),
    ).model;

    const read = update(
      opened,
      SucceededReadApplication({ requestId: opened.detailRequestId, application }),
    ).model;

    const confirming = update(update(read, RequestedDelete()).model, ConfirmedDelete());

    expect(update(confirming.model, ConfirmedDelete()).commands).toEqual([]);
    expect(
      update(confirming.model, GotDeleteDialogMessage({ message: Dialog.Message.RequestedClose() }))
        .model.deleteDialog.isOpen,
    ).toBe(true);

    const outcome = await Effect.runPromise(confirming.commands![0]!.effect);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "DELETE",
      url: `https://dashboard.test/api/team-applications/${application.applicationId}`,
    });
    expect(sent[0]!.headers.get("idempotency-key")).toBe(`${seed}-0`);

    const deleted = update(confirming.model, outcome);

    expect(deleted.model).toMatchObject({ notice: "Deleted", selectedApplicationId: null });
    expect(deleted.model.detail).toEqual(DetailData.Idle());
    expect(deleted.model.deleteDialog.isOpen).toBe(false);
    expect(deleted.commands?.map((command) => command.name)).toContain("LoadTeamApplicationPage");
  });

  it("drops cached applications when a reload is denied but keeps them through an outage", () => {
    const update = updateFor(commandsFor(inert));

    const opened = update(
      loaded(update),
      OpenedApplication({ applicationId: application.applicationId }),
    ).model;

    const reading = update(
      opened,
      SucceededReadApplication({ requestId: opened.detailRequestId, application }),
    ).model;

    const retrying = update(reading, RetriedPage()).model;

    const outage = update(
      retrying,
      FailedLoadPage({ requestId: retrying.pageRequestId, failure: "Unavailable" }),
    ).model;

    expect(Predicate.isTagged(outage.page, "Stale")).toBe(true);
    expect(outage.selectedApplicationId).toBe(application.applicationId);

    const retryingAgain = update(outage, RetriedPage()).model;

    const denied = update(
      retryingAgain,
      FailedLoadPage({ requestId: retryingAgain.pageRequestId, failure: "Denied" }),
    ).model;

    expect(denied).toMatchObject({ selectedApplicationId: null, intakeDraft: null });
    expect(denied.page).toEqual(PageData.Failure({ error: "Denied" }));
    expect(denied.detail).toEqual(DetailData.Idle());
  });

  it("keeps a saved intake when an older page read completes afterwards", () => {
    const update = updateFor(commandsFor(inert));
    const paging = update(loaded(update), RequestedNextPage()).model;

    const saving = update(
      update(paging, ToggledAcceptApplication({ isChecked: false })).model,
      SubmittedIntake(),
    ).model;

    const saved = update(
      saving,
      SucceededReviseIntake({
        requestId: saving.mutationRequestId,
        intake: S.decodeSync(TeamApplicationIntakeResource)(
          intake({ acceptApplication: false, open: false, revision: 4, etag: etag("B") }),
        ),
      }),
    ).model;

    const late = update(
      saved,
      SucceededLoadPage({ requestId: paging.pageRequestId, page: listPage({ items: [] }) }),
    ).model;

    expect(Option.getOrUndefined(AsyncData.getData(late.page))).toMatchObject({
      items: [],
      intake: { revision: 4, etag: etag("B") },
    });
    expect(late.intakeDraft?.basedOnEtag).toBe(etag("B"));
  });
});
