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

import { Effect, Schema } from "effect"
import type { Transport } from "../../transport.js"
import { type InternalSdkError } from "../../errors.js"
import {
  AssignedInterview,
  InterviewFromRaw,
  InterviewSchema_,
  type AssignedInterviewId,
  type Cycle,
  type Interview,
  type InterviewScheduleInput,
} from "../../schemas/interview.js"

export interface AdminInterviewsDomain {
  listAssigned(cycle: Cycle): Effect.Effect<readonly AssignedInterview[], InternalSdkError>
  readAssigned(cycle: Cycle, interviewId: AssignedInterviewId): Effect.Effect<AssignedInterview, InternalSdkError>
  scheduleForCycle(
    cycle: Cycle,
    interviewId: AssignedInterviewId,
    input: InterviewScheduleInput,
  ): Effect.Effect<void, InternalSdkError>

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

  schemas(): Effect.Effect<readonly typeof InterviewSchema_.Type[], InternalSdkError>
}

export function createAdminInterviewsDomain(transport: Transport): AdminInterviewsDomain {
  return {
    listAssigned(cycle) {
      return transport.get(
        "/api/admin/interviews/assigned",
        Schema.Array(AssignedInterview),
        {
          departmentId: cycle.departmentId,
          semesterId: cycle.semesterId,
        },
      )
    },

    readAssigned(cycle, interviewId) {
      return transport.get(
        `/api/admin/interviews/assigned/${encodeURIComponent(interviewId)}`,
        AssignedInterview,
        {
          departmentId: cycle.departmentId,
          semesterId: cycle.semesterId,
        },
      )
    },

    scheduleForCycle(cycle, interviewId, input) {
      return transport.put(`/api/admin/interviews/assigned/${encodeURIComponent(interviewId)}/schedule`, {
        departmentId: cycle.departmentId,
        semesterId: cycle.semesterId,
        interviewTime: input.interviewTime,
        room: input.room,
        campus: input.campus,
      })
    },


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
        interviewSchemaId: schemaId,
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
      return transport
        .getCollection("/api/admin/interview-schemas", InterviewSchema_)
        .pipe(Effect.map(({ items }) => items))
    },
  }
}
