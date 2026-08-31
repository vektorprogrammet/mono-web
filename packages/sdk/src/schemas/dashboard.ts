/**
 * Client projection for dashboard summary statistics.
 *
 * @since 0.2.0
 */
import { Schema } from "effect";

export class DashboardStats extends Schema.Class<DashboardStats>("DashboardStats")({
  name: Schema.String,
  department: Schema.String,
  activeAssistants: Schema.Number,
  pendingApplications: Schema.Number,
  upcomingInterviews: Schema.Number,
}) {}
