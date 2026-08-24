import { expect, it } from "@effect/vitest";
import { Effect, Schema as S } from "effect";
import * as fc from "effect/testing/FastCheck";
import { AsyncData, FieldValidation } from "foldkit";
import type { InvitationResponseClient } from "./browser-client";
import { InvitationResponseObservationSchema } from "./bridge";
import { makeInterviewCommands } from "./command";
import {
  ConfirmedInvitation,
  FailedInvitationResponse,
  FailedReadInvitationResponse,
  Message,
  RejectedInvitation,
  RequestedNewInvitationTime,
  SucceededInvitationResponse,
  SucceededReadInvitationResponse,
} from "./message";
import { InvitationResponseData, Model, makeInitialModel } from "./model";
import { makeUpdate } from "./update";

const decodeObservation = (
  responseState: "Pending" | "Accepted" | "Rejected" | "RequestedNewTime",
) =>
  S.decodeUnknownSync(InvitationResponseObservationSchema)(
    {
      scheduledAt: "2031-09-20T13:30:00.000Z",
      room: "K-101",
      campus: "Gløshaugen",
      responseState,
      responseMessage:
        responseState === "RequestedNewTime" ? "Kan vi avtale et annet tidspunkt?" : null,
    },
    { onExcessProperty: "error" },
  );

const dormantClient: InvitationResponseClient = {
  recruitmentInvitationResponses: {
    read: () => Effect.die("not executed by transition tests"),
    confirm: () => Effect.die("not executed by transition tests"),
    reject: () => Effect.die("not executed by transition tests"),
    requestNewTime: () => Effect.die("not executed by transition tests"),
  },
};
const update = makeUpdate(makeInterviewCommands(dormantClient));

const pendingModel = (): Model => ({
  ...makeInitialModel(),
  invitationResponse: InvitationResponseData.Success({ data: decodeObservation("Pending") }),
  requestId: 1,
});

const bridgeFailure = {
  _tag: "InvitationAlreadyResponded",
  message: "Invitation already responded",
} as const;

it("loads every native response state through a current read observation", () => {
  for (const responseState of ["Pending", "Accepted", "Rejected", "RequestedNewTime"] as const) {
    const loading: Model = {
      ...makeInitialModel(),
      invitationResponse: InvitationResponseData.Loading(),
      requestId: 1,
    };
    const [next] = update(
      loading,
      SucceededReadInvitationResponse({
        requestId: 1,
        observation: decodeObservation(responseState),
      }),
    );
    expect(next.invitationResponse._tag).toBe("Success");
  }
});

it("emits response transitions only from Pending", () => {
  for (const responseState of ["Accepted", "Rejected", "RequestedNewTime"] as const) {
    const terminal: Model = {
      ...pendingModel(),
      invitationResponse: InvitationResponseData.Success({
        data: decodeObservation(responseState),
      }),
    };
    for (const attempted of [
      ConfirmedInvitation(),
      RejectedInvitation(),
      RequestedNewInvitationTime(),
    ]) {
      const [next, commands] = update(terminal, attempted);
      expect(next).toBe(terminal);
      expect(commands).toEqual([]);
    }
  }
});

it("keeps the pending observation until a confirm command returns its fresh read", () => {
  const initial = pendingModel();
  const [inFlight, commands] = update(initial, ConfirmedInvitation());

  expect(inFlight.selectedAction).toBe("Confirm");
  expect(inFlight.invitationResponse).toBe(initial.invitationResponse);
  expect(commands).toHaveLength(1);

  const [completed] = update(
    inFlight,
    SucceededInvitationResponse({
      requestId: inFlight.requestId,
      action: "Confirm",
      observation: decodeObservation("Accepted"),
    }),
  );
  expect(completed.selectedAction).toBeNull();
  const completedObservation = AsyncData.getData(completed.invitationResponse);
  expect(completedObservation._tag).toBe("Some");
  if (completedObservation._tag !== "Some") throw new Error("expected a fresh observation");
  expect(completedObservation.value).toEqual(decodeObservation("Accepted"));
});

it("executes the mutation before the mandatory fresh read", async () => {
  const operations: string[] = [];
  const client: InvitationResponseClient = {
    recruitmentInvitationResponses: {
      confirm: () =>
        Effect.sync(() => {
          operations.push("confirm");
        }),
      read: () =>
        Effect.sync(() => {
          operations.push("read");
          return decodeObservation("Accepted");
        }),
      reject: () => Effect.die("not used"),
      requestNewTime: () => Effect.die("not used"),
    },
  };
  const command = makeInterviewCommands(client).ConfirmInvitation({ requestId: 7 });
  const result = await Effect.runPromise(command.effect);

  expect(operations).toEqual(["confirm", "read"]);
  expect(result).toEqual(
    SucceededInvitationResponse({
      requestId: 7,
      action: "Confirm",
      observation: decodeObservation("Accepted"),
    }),
  );
});

it("allows a blank rejection message and normalizes it to absent", () => {
  const [next, commands] = update(pendingModel(), RejectedInvitation());

  expect(next.selectedAction).toBe("Reject");
  expect(commands).toHaveLength(1);
  expect(commands[0]?.args).toEqual({ requestId: next.requestId, message: null });
});

it("requires a bounded message only when requesting a new time", () => {
  const [blank, blankCommands] = update(pendingModel(), RequestedNewInvitationTime());
  expect(blank.validationFeedback).toBe("Skriv en melding før du ber om nytt tidspunkt.");
  expect(blankCommands).toEqual([]);

  const tooLong = {
    ...pendingModel(),
    responseMessage: FieldValidation.NotValidated({ value: "x".repeat(2_001) }),
  };
  const [invalidReject, invalidRejectCommands] = update(tooLong, RejectedInvitation());
  const [invalidNewTime, invalidNewTimeCommands] = update(tooLong, RequestedNewInvitationTime());
  expect(invalidReject.validationFeedback).toContain("2000");
  expect(invalidRejectCommands).toEqual([]);
  expect(invalidNewTime.validationFeedback).toContain("nytt tidspunkt");
  expect(invalidNewTimeCommands).toEqual([]);

  const valid = {
    ...pendingModel(),
    responseMessage: FieldValidation.NotValidated({ value: `  ${"x".repeat(2_000)}  ` }),
  };
  const [requested, commands] = update(valid, RequestedNewInvitationTime());
  expect(requested.selectedAction).toBe("RequestNewTime");
  expect(commands[0]?.args).toEqual({ requestId: requested.requestId, message: "x".repeat(2_000) });
});

it("excludes every competing action while one command is in flight", () => {
  const [inFlight] = update(pendingModel(), ConfirmedInvitation());

  for (const competing of [
    ConfirmedInvitation(),
    RejectedInvitation(),
    RequestedNewInvitationTime(),
  ]) {
    const [next, commands] = update(inFlight, competing);
    expect(next).toBe(inFlight);
    expect(commands).toEqual([]);
  }
});

it("preserves typed failures without replacing the current observation", () => {
  const [inFlight] = update(pendingModel(), ConfirmedInvitation());
  const [failed] = update(
    inFlight,
    FailedInvitationResponse({
      requestId: inFlight.requestId,
      action: "Confirm",
      failure: bridgeFailure,
    }),
  );

  expect(failed.selectedAction).toBeNull();
  expect(failed.failure).toEqual(bridgeFailure);
  expect(failed.invitationResponse).toBe(inFlight.invitationResponse);
});

it("rejects stale read, command success, and command failure observations", () => {
  const current = {
    ...pendingModel(),
    selectedAction: "Confirm" as const,
    requestId: 4,
  };
  const staleMessages = [
    SucceededReadInvitationResponse({ requestId: 3, observation: decodeObservation("Pending") }),
    FailedReadInvitationResponse({ requestId: 3, failure: bridgeFailure }),
    SucceededInvitationResponse({
      requestId: 3,
      action: "Confirm",
      observation: decodeObservation("Accepted"),
    }),
    SucceededInvitationResponse({
      requestId: 4,
      action: "Reject",
      observation: decodeObservation("Rejected"),
    }),
    FailedInvitationResponse({ requestId: 3, action: "Confirm", failure: bridgeFailure }),
  ];

  for (const stale of staleMessages) {
    const [next, commands] = update(current, stale);
    expect(next).toBe(current);
    expect(commands).toEqual([]);
  }
});

it("does not adopt a fresh read that contradicts the completed operation", () => {
  const [inFlight] = update(pendingModel(), ConfirmedInvitation());
  const [next] = update(
    inFlight,
    SucceededInvitationResponse({
      requestId: inFlight.requestId,
      action: "Confirm",
      observation: decodeObservation("Pending"),
    }),
  );

  expect(next.invitationResponse).toBe(inFlight.invitationResponse);
  expect(next.failure?._tag).toBe("InvitationUnavailable");
});

it.prop(
  "every generated model and message preserves the model schema",
  {
    model: S.toArbitrary(Model)(fc),
    message: S.toArbitrary(Message)(fc),
  },
  ({ model, message }) => {
    const [next] = update(model, message);
    expect(() => S.decodeUnknownSync(Model)(next)).not.toThrow();
  },
  { fastCheck: { seed: 26082028, numRuns: 150 } },
);
