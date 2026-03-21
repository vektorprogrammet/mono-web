import { Schema } from "effect"

export class DashboardStats extends Schema.Class<DashboardStats>("DashboardStats")({
  name: Schema.String,
  department: Schema.String,
  activeAssistants: Schema.Number,
  pendingApplications: Schema.Number,
  upcomingInterviews: Schema.Number,
}) {}
