import {
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  flow,
  Layer,
  Option,
  Result,
  Schedule,
  Schema,
} from "effect";
import * as PersistedQueue from "effect/unstable/persistence/PersistedQueue";
import { SqlSchema } from "effect/unstable/sql";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";
import { Mail } from "@vektorprogrammet/domain/mail";
import {
  TeamApplicationEnvelope,
  TeamApplicationOutboxDelivery,
  TeamApplicationOutboxRequest,
  type TeamApplicationNotification,
} from "@vektorprogrammet/domain/team-application";
import { Database, type DatabaseOperations } from "../service.js";
import { persistenceFailure } from "./persistence.js";

/**
 * team_application_outbox holds each committed notification's identity, private envelope,
 * delivery policy, and outcome. Its PersistedQueue item names only the effect; the queue
 * owns the lease, the attempt count, and the retry visibility. Migration 78 creates the
 * store schema and the `team_application_delivery_state` view over both rows.
 */
const queueName = "team-application-notification";

const TeamApplicationDeliveryItem = Schema.Struct({
  effectId: TeamApplicationOutboxRequest.cases.SendTeamApplicationReceipt.fields.effectId,
});

export interface TeamApplicationDeliveryOptions {
  /** Poll period of a delivery that waits for a due item. */
  readonly pollInterval: Duration.Input;
  /** A lease whose worker stopped refreshing it this long ago is taken again. */
  readonly lockExpiration: Duration.Input;
  readonly lockRefreshInterval: Duration.Input;
  /** The attempt with this number is the last: its temporary failure quarantines the effect. */
  readonly maxAttempts: number;
  /** Retry delays double from one second up to this bound. */
  readonly retryDelayMax: Duration.Input;
}

const defaultOptions: TeamApplicationDeliveryOptions = {
  pollInterval: "1 second",
  lockExpiration: "1 minute",
  lockRefreshInterval: "20 seconds",
  maxAttempts: 48,
  retryDelayMax: "5 minutes",
};

/** The queue never fails an item by its count: the outbox policy ends it after `maxAttempts`. */
const unboundedQueueAttempts = 2_147_483_647;

/** Completed queue items stay this long. The outbox rows keep every outcome for good. */
const completedItemRetention = Duration.days(30);

export class TeamApplicationDeliveryQueue extends Context.Service<
  TeamApplicationDeliveryQueue,
  {
    readonly queue: PersistedQueue.PersistedQueue<typeof TeamApplicationDeliveryItem.Type>;
    readonly store: PersistedQueue.PersistedQueueStore["Service"];
    readonly maxAttempts: number;
  }
>()("@vektorprogrammet/database/team-application/TeamApplicationDeliveryQueue") {}

/**
 * Builds a queue store on the caller's Database, so an offer joins the caller's
 * transaction. Each store is one worker identity for the lease. A store that cannot start
 * is a startup defect, as the store treats its own schema check.
 */
export const TeamApplicationDeliveryQueueLive = (
  overrides: Partial<TeamApplicationDeliveryOptions> = {},
) =>
  Layer.effect(
    TeamApplicationDeliveryQueue,
    Effect.gen(function* () {
      const options = { ...defaultOptions, ...overrides };

      const store = yield* PersistedQueue.makeStoreSql({
        tableName: "effect_queue",
        pollInterval: options.pollInterval,
        lockRefreshInterval: options.lockRefreshInterval,
        lockExpiration: options.lockExpiration,
      }).pipe(Effect.provideService(SqlClient.SqlClient, yield* Database), Effect.orDie);

      const factory = yield* PersistedQueue.makeFactory.pipe(
        Effect.provideService(PersistedQueue.PersistedQueueStore, store),
      );

      const queue = yield* factory.make({
        name: queueName,
        schema: TeamApplicationDeliveryItem,
        maxAttempts: unboundedQueueAttempts,
        retrySchedule: Schedule.min([
          Schedule.exponential("1 second"),
          Schedule.spaced(options.retryDelayMax),
        ]),
      });

      return TeamApplicationDeliveryQueue.of({ queue, store, maxAttempts: options.maxAttempts });
    }),
  );

/** Stores the envelope and enqueues its effect in the caller's transaction. */
export const insertTeamApplicationOutbox = (
  notification: TeamApplicationNotification,
  ordinal: number,
  committedAt: string,
) =>
  Effect.gen(function* () {
    const { effectId } = notification.request;

    yield* Database.use(
      (sql) => sql`
        INSERT INTO public.team_application_outbox (
          effect_id, effect_type, team_id, application_id, command_id, ordinal, payload_json,
          status, committed_at
        ) VALUES (
          ${effectId}, ${notification.request._tag},
          ${notification.request.teamId}, ${notification.request.applicationId},
          ${notification.request.commandId}, ${ordinal},
          ${sql.json(Schema.encodeSync(TeamApplicationEnvelope)(notification.envelope))},
          'Pending', ${committedAt}
        )
      `,
    ).pipe(Effect.mapError(persistenceFailure("insert team application outbox")));

    const { queue } = yield* TeamApplicationDeliveryQueue;

    yield* queue
      .offer({ effectId }, { id: effectId })
      .pipe(Effect.mapError(persistenceFailure("enqueue team application notification")));
  });

/** Deletion stops every undelivered notification of the application and clears its envelope. */
export const cancelTeamApplicationOutbox = (applicationId: string) =>
  Database.use(
    (sql) => sql`
      UPDATE public.team_application_outbox SET
        status = 'Cancelled', payload_json = '{}'::jsonb, last_failure_tag = 'TeamApplicationDeleted'
      WHERE application_id = ${applicationId} AND status IN ('Pending', 'Failed')
    `,
  ).pipe(Effect.asVoid, Effect.mapError(persistenceFailure("cancel team application outbox")));

const findEffect = flow(
  SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({
      status: Schema.Literals(["Pending", "Failed", "Delivered", "Quarantined", "Cancelled"]),
      payload: Schema.Unknown,
    }),
    execute: (effectId) =>
      Database.use(
        (sql) => sql`
          SELECT status, payload_json AS payload
          FROM public.team_application_outbox
          WHERE effect_id = ${effectId}
        `,
      ),
  }),
  Effect.mapError(persistenceFailure("read team application outbox")),
);

/** The attempt number is the lease token: a later take of the item raises it. */
interface Lease {
  readonly effectId: string;
  readonly attempt: number;
}

/** A temporary provider failure; the queue stores its message and retries after the backoff. */
class TeamApplicationDeliveryAttemptFailed extends Data.TaggedError(
  "TeamApplicationDeliveryAttemptFailed",
)<{
  readonly effectId: string;
  readonly failureTag: string;
}> {
  override get message() {
    return this.failureTag;
  }
}

/**
 * The attempt lost its lease. Failing it makes the store retry the item only if this
 * worker still holds it, so a successor's lease stays intact.
 */
class TeamApplicationLeaseLost extends Data.TaggedError("TeamApplicationLeaseLost")<{
  readonly effectId: string;
}> {}

/**
 * Writes an attempt's outcome to its outbox row only while the attempt holds the queue
 * lease, then runs `onRecorded`. The lease row stays locked for the write, so no take of
 * an expired lease can interleave. Superseded: deletion recorded an outcome first.
 * LeaseLost: a later attempt took the lease, so this attempt records nothing.
 */
const recordOutcome = <E>(
  operation: string,
  lease: Lease,
  assignments: (sql: DatabaseOperations) => Statement.Fragment,
  onRecorded: Effect.Effect<TeamApplicationOutboxDelivery, E>,
) =>
  Database.use(
    (sql) => sql<{ readonly leased: boolean; readonly recorded: boolean }>`
      WITH lease AS (
        SELECT id FROM public.effect_queue
        WHERE queue_name = ${queueName} AND id = ${lease.effectId} AND state = 'pending'
          AND acquired_by IS NOT NULL AND attempts = ${lease.attempt}
        FOR UPDATE
      ), recorded AS (
        UPDATE public.team_application_outbox AS outbox
        SET ${assignments(sql)}
        FROM lease
        WHERE outbox.effect_id = lease.id AND outbox.status IN ('Pending', 'Failed')
        RETURNING outbox.effect_id
      )
      SELECT EXISTS (SELECT 1 FROM lease) AS leased, EXISTS (SELECT 1 FROM recorded) AS recorded
    `,
  ).pipe(
    Effect.mapError(persistenceFailure(operation)),
    Effect.flatMap(
      ([row]): Effect.Effect<TeamApplicationOutboxDelivery, E | TeamApplicationLeaseLost> => {
        if (row?.recorded === true) return onRecorded;

        if (row?.leased === true)
          return Effect.succeed(
            TeamApplicationOutboxDelivery.Superseded({ effectId: lease.effectId }),
          );

        return Effect.fail(new TeamApplicationLeaseLost({ effectId: lease.effectId }));
      },
    ),
  );

const quarantine = (lease: Lease, failureTag: string) =>
  recordOutcome(
    "quarantine team application outbox",
    lease,
    (sql) =>
      sql`status = 'Quarantined', payload_json = '{}'::jsonb, last_failure_tag = ${failureTag}`,
    Effect.succeed(
      TeamApplicationOutboxDelivery.Quarantined({ effectId: lease.effectId, failureTag }),
    ),
  );

/**
 * One attempt for a taken item. A temporary provider failure before the last attempt fails
 * the attempt, so the queue retries it after its backoff. A permanent or ambiguous failure,
 * the last attempt's failure, and an undecodable envelope quarantine the effect. A settled
 * effect needs no provider call. Every outcome is written under the attempt's lease.
 */
const deliver = (lease: Lease, sender: string, maxAttempts: number) =>
  Effect.gen(function* () {
    const { effectId } = lease;
    const stored = yield* findEffect(effectId);

    if (Option.isNone(stored))
      return TeamApplicationOutboxDelivery.Skipped({ effectId, status: "Missing" });

    const { status, payload } = stored.value;

    if (status !== "Pending" && status !== "Failed")
      return TeamApplicationOutboxDelivery.Skipped({ effectId, status });

    // A process stopped during the last attempt, so the queue offers the effect once more.
    if (lease.attempt > maxAttempts)
      return yield* quarantine(lease, "TeamApplicationDeliveryLeaseExpired");

    const envelope = Schema.decodeUnknownOption(TeamApplicationEnvelope)(payload, {
      onExcessProperty: "error",
    });

    if (Option.isNone(envelope) || envelope.value.deliveryId !== effectId)
      return yield* quarantine(lease, "InvalidTeamApplicationEnvelope");

    const delivery = yield* Mail.use((mail) =>
      mail.deliver({
        deliveryId: envelope.value.deliveryId,
        sender,
        recipient: envelope.value.recipient,
        replyTo: envelope.value.replyTo,
        subject: envelope.value.subject,
        text: envelope.value.text,
      }),
    ).pipe(Effect.result);

    if (Result.isSuccess(delivery))
      return yield* recordOutcome(
        "deliver team application outbox",
        lease,
        (sql) => sql`status = 'Delivered', payload_json = '{}'::jsonb, last_failure_tag = NULL`,
        Effect.succeed(TeamApplicationOutboxDelivery.Delivered({ effectId })),
      );

    const failureTag = `MailDeliveryError:${delivery.failure.kind}`;

    if (delivery.failure.kind !== "temporary-unavailability" || lease.attempt >= maxAttempts)
      return yield* quarantine(lease, failureTag);

    return yield* recordOutcome(
      "fail team application outbox",
      lease,
      (sql) => sql`status = 'Failed', last_failure_tag = ${failureTag}`,
      Effect.fail(new TeamApplicationDeliveryAttemptFailed({ effectId, failureTag })),
    );
  });

/**
 * Takes the next due notification and attempts it, or returns Idle when none is taken
 * within `idle`. The queue blocks while it is empty, so the first of the attempt and the
 * idle wait to complete `window` decides: an item taken after the wait closed it is
 * released uncounted, as an interruption. Interruption during the provider call also
 * releases the item without counting the attempt.
 */
export const deliverNextTeamApplicationOutbox = (sender: string, idle: Duration.Duration) =>
  Effect.gen(function* () {
    const { queue, maxAttempts } = yield* TeamApplicationDeliveryQueue;
    const window = yield* Deferred.make<void>();

    const attempt = queue
      .take(({ effectId }, { attempts }) =>
        Deferred.succeed(window, undefined).pipe(
          Effect.flatMap((open) =>
            open ? deliver({ effectId, attempt: attempts }, sender, maxAttempts) : Effect.interrupt,
          ),
        ),
      )
      .pipe(
        Effect.catchTags({
          TeamApplicationDeliveryAttemptFailed: ({ effectId, failureTag }) =>
            Effect.succeed(TeamApplicationOutboxDelivery.Failed({ effectId, failureTag })),
          TeamApplicationLeaseLost: ({ effectId }) =>
            Effect.succeed(TeamApplicationOutboxDelivery.LeaseLost({ effectId })),
          PersistedQueueError: (cause) =>
            Effect.fail(persistenceFailure("take team application notification")(cause)),
        }),
      );

    const idleWait = Effect.sleep(idle).pipe(
      Effect.andThen(Deferred.succeed(window, undefined)),
      Effect.flatMap((closed) =>
        closed ? Effect.succeed(TeamApplicationOutboxDelivery.Idle()) : Effect.never,
      ),
    );

    return yield* Effect.raceFirst(attempt, idleWait);
  });

/** Removes queue items that completed before the retention; their outbox rows stay. */
export const cleanUpTeamApplicationDeliveryQueue = Effect.gen(function* () {
  const { store } = yield* TeamApplicationDeliveryQueue;

  yield* store
    .cleanup({ timeToLive: completedItemRetention, failedTimeToLive: undefined })
    .pipe(Effect.mapError(persistenceFailure("clean up team application delivery queue")));
});
