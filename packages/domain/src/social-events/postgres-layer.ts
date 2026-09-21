import { Layer } from "effect";
import {
  createSocialEventPostgres,
  readSocialEventListPostgres,
  readSocialEventScopePostgres,
  readSocialEventSnapshotInstantPostgres,
  validateSocialEventScopePostgres,
} from "./postgres.js";
import { SocialEvents } from "./service.js";

/** Live social-event persistence whose effects consume the caller's Database. */
export const SocialEventsLive: Layer.Layer<SocialEvents> = Layer.succeed(
  SocialEvents,
  SocialEvents.of({
    readSnapshotInstant: readSocialEventSnapshotInstantPostgres,
    readScope: readSocialEventScopePostgres,
    readList: readSocialEventListPostgres,
    validateScope: validateSocialEventScopePostgres,
    create: createSocialEventPostgres,
  }),
);
