import { Schema } from "effect"

export class SchedulingAssistant extends Schema.Class<SchedulingAssistant>("SchedulingAssistant")({
  id: Schema.Number,
  name: Schema.String,
  email: Schema.String,
  doublePosition: Schema.NullOr(Schema.Boolean),
  preferredGroup: Schema.NullOr(Schema.Number),
  availability: Schema.Record({ key: Schema.String, value: Schema.Boolean }),
  score: Schema.NullOr(Schema.Number),
  suitability: Schema.NullOr(Schema.String),
  previousParticipation: Schema.NullOr(Schema.Boolean),
  language: Schema.NullOr(Schema.String),
}) {}

export class SchedulingSchool extends Schema.Class<SchedulingSchool>("SchedulingSchool")({
  id: Schema.Number,
  name: Schema.String,
  capacity: Schema.Array(Schema.Record({ key: Schema.String, value: Schema.Number })),
}) {}

export class Substitute extends Schema.Class<Substitute>("Substitute")({
  id: Schema.Number,
  name: Schema.String,
  email: Schema.String,
  yearOfStudy: Schema.NullOr(Schema.Number),
  language: Schema.NullOr(Schema.String),
  monday: Schema.NullOr(Schema.Boolean),
  tuesday: Schema.NullOr(Schema.Boolean),
  wednesday: Schema.NullOr(Schema.Boolean),
  thursday: Schema.NullOr(Schema.Boolean),
  friday: Schema.NullOr(Schema.Boolean),
}) {}
