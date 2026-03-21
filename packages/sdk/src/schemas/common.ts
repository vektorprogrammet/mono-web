import { Schema } from "effect"

// --- Page (generic collection response, post-Hydra-unwrap) ---

export class Page<A> {
  constructor(
    readonly items: A[],
    readonly totalItems: number,
    readonly page: number = 1,
    readonly pageSize: number = 30,
  ) {}
}

// Pagination params for list methods
export const PaginationParams = Schema.Struct({
  page: Schema.optional(Schema.Number),
  pageSize: Schema.optional(Schema.Number),
})
export type PaginationParams = Schema.Schema.Type<typeof PaginationParams>

// --- Shared domain types ---

export class Department extends Schema.Class<Department>("Department")({
  id: Schema.Number,
  name: Schema.String,
  city: Schema.String,
}) {}

export class Team extends Schema.Class<Team>("Team")({
  id: Schema.Number,
  name: Schema.String,
}) {}

export class TeamInterest extends Schema.Class<TeamInterest>("TeamInterest")({
  id: Schema.Number,
  userName: Schema.String,
  teamName: Schema.String,
}) {}

export class FieldOfStudy extends Schema.Class<FieldOfStudy>("FieldOfStudy")({
  id: Schema.Number,
  name: Schema.String,
}) {}

export class Sponsor extends Schema.Class<Sponsor>("Sponsor")({
  id: Schema.Number,
  name: Schema.String,
  logoUrl: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
}) {}

export class MailingList extends Schema.Class<MailingList>("MailingList")({
  name: Schema.String,
  emails: Schema.Array(Schema.String),
}) {}

export class AdmissionStats extends Schema.Class<AdmissionStats>("AdmissionStats")({
  totalApplicants: Schema.Number,
  accepted: Schema.Number,
  rejected: Schema.Number,
  interviewed: Schema.Number,
  assignedAssistants: Schema.Number,
}) {}
