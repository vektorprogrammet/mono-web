/**
 * Admin interviews domain — list, assign, schedule, conduct, cancel, schemas.
 *
 * Endpoints:
 *   GET  /api/admin/interviews
 *   POST /api/admin/interviews/assign
 *   POST /api/admin/interviews/{id}/schedule
 *   POST /api/admin/interviews/{id}/conduct
 *   PUT  /api/admin/interviews/{id}/cancel
 *   GET  /api/admin/interview-schemas
 */

import { Effect } from "effect"
import type { Transport } from "../../transport.js"
import type { InternalSdkError } from "../../errors.js"
import { InterviewFromRaw, InterviewSchema_, type Interview, type InterviewScheduleInput } from "../../schemas/interview.js"

export interface AdminInterviewsDomain {
  list(params?: {
    page?: number
    pageSize?: number
  }): Effect.Effect<{ items: Interview[]; totalItems: number }, InternalSdkError>

  assign(
    applicationId: number,
    interviewerId: number,
    schemaId: number,
  ): Effect.Effect<void, InternalSdkError>

  schedule(
    id: number,
    input: typeof InterviewScheduleInput.Type,
  ): Effect.Effect<void, InternalSdkError>

  conduct(
    id: number,
    score: number | null,
    answers: Record<string, string>,
  ): Effect.Effect<void, InternalSdkError>

  cancel(id: number): Effect.Effect<void, InternalSdkError>

  schemas(): Effect.Effect<{ items: typeof InterviewSchema_.Type[]; totalItems: number }, InternalSdkError>
}

export function createAdminInterviewsDomain(transport: Transport): AdminInterviewsDomain {
  return {
    list(params) {
      const query: Record<string, string | number | undefined> = {}
      if (params?.page !== undefined) query.page = params.page
      if (params?.pageSize !== undefined) query.itemsPerPage = params.pageSize
      return transport.getCollection("/api/admin/interviews", InterviewFromRaw, query)
    },

    assign(applicationId, interviewerId, schemaId) {
      return transport.postVoid("/api/admin/interviews/assign", {
        applicationId,
        interviewerId,
        schemaId,
      })
    },

    schedule(id, input) {
      return transport.put(`/api/admin/interviews/${id}/schedule`, input)
    },

    conduct(id, score, answers) {
      return transport.postVoid(`/api/admin/interviews/${id}/conduct`, { score, answers })
    },

    cancel(id) {
      return transport.put(`/api/admin/interviews/${id}/cancel`, {})
    },

    schemas() {
      return transport.getCollection("/api/admin/interview-schemas", InterviewSchema_)
    },
  }
}
