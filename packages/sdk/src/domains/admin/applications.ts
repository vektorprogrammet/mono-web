/**
 * Admin applications domain — list, get, delete, bulk-delete.
 *
 * Endpoints:
 *   GET    /api/admin/applications
 *   GET    /api/admin/applications/{id}
 *   DELETE /api/admin/applications/{id}
 *   POST   /api/admin/applications/bulk-delete
 */

import { Effect, Schema } from "effect";
import type { Transport } from "../../transport.js";
import type { InternalSdkError } from "../../errors.js";
import {
  ApplicationFromRaw,
  ApplicationDetailFromRaw,
  type Application,
  type ApplicationDetail,
} from "../../schemas/application.js";

const ApplicationListResponse = Schema.Union([
  Schema.Struct({
    status: Schema.String,
    applications: Schema.Array(ApplicationFromRaw),
  }),
  Schema.Struct({
    "hydra:member": Schema.Array(ApplicationFromRaw),
    "hydra:totalItems": Schema.Number,
  }),
]);

export interface AdminApplicationsDomain {
  list(params?: {
    page?: number;
    pageSize?: number;
    status?: string;
  }): Effect.Effect<{ items: Application[]; totalItems: number }, InternalSdkError>;

  get(id: number): Effect.Effect<ApplicationDetail, InternalSdkError>;

  delete(id: number): Effect.Effect<void, InternalSdkError>;

  bulkDelete(ids: number[]): Effect.Effect<void, InternalSdkError>;
}

export function createAdminApplicationsDomain(transport: Transport): AdminApplicationsDomain {
  return {
    list(params) {
      const query: Record<string, string | number | undefined> = {};
      if (params?.page !== undefined) query.page = params.page;
      if (params?.pageSize !== undefined) query.itemsPerPage = params.pageSize;
      if (params?.status !== undefined) query.status = params.status;
      return transport.get("/api/admin/applications", ApplicationListResponse, query).pipe(
        Effect.map((response) => {
          const applications =
            "applications" in response ? response.applications : response["hydra:member"];
          return {
            items: [...applications],
            totalItems:
              "applications" in response ? applications.length : response["hydra:totalItems"],
            page: params?.page ?? 1,
            pageSize: params?.pageSize ?? 30,
          };
        }),
      );
    },

    get(id) {
      return transport.get(`/api/admin/applications/${id}`, ApplicationDetailFromRaw);
    },

    delete(id) {
      return transport.del(`/api/admin/applications/${id}`);
    },

    bulkDelete(ids) {
      return transport.postVoid("/api/admin/applications/bulk-delete", { ids });
    },
  };
}
