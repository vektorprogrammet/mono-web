import { Effect, Schema } from "effect";
import type { Transport } from "../transport.js";
import type { InternalSdkError } from "../errors.js";
import { ReceiptDecodeError } from "../errors.js";
import {
  CommandId,
  Receipt,
  ReceiptApprovalFilter,
  ReceiptCommandObservation,
  ReceiptCreateResponse,
  ReceiptId,
  ReceiptInput,
  ReceiptOwnerFilter,
  ReceiptPage,
  ReceiptResolutionInput,
  ReceiptRevision,
  ReceiptReviseInput,
  ReceiptSubmitInput,
  ReceiptWithdrawInput,
} from "../schemas/receipt.js";
const decodeCanonical = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  value: unknown,
): Effect.Effect<A, ReceiptDecodeError> =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new ReceiptDecodeError()),
  );

const isBrowserFile = (value: unknown): value is File =>
  typeof File !== "undefined" && value instanceof File;

const receiptQuery = (
  filter: typeof ReceiptOwnerFilter.Type,
): Record<string, string | number | undefined> => {
  const query: Record<string, string | number | undefined> = {};
  if (filter.status !== undefined) query.status = filter.status;
  if (filter.page !== undefined) query.page = filter.page;
  if (filter.pageSize !== undefined) query.itemsPerPage = filter.pageSize;
  return query;
};

const approvalReceiptQuery = (
  filter: typeof ReceiptApprovalFilter.Type,
): Record<string, string | number | undefined> => {
  const query: Record<string, string | number | undefined> = {};
  if (filter.status !== undefined) query.status = filter.status;
  return query;
};

export interface ReceiptsDomain {
  // Legacy CRUD remains separate until its own native cut-over specification.
  list(params?: {
    status?: string;
    page?: number;
    pageSize?: number;
  }): Effect.Effect<{ items: Receipt[]; totalItems: number }, InternalSdkError>;
  create(
    input: typeof ReceiptInput.Type,
    file?: File,
  ): Effect.Effect<{ id: number }, InternalSdkError>;
  update(
    id: number,
    input: typeof ReceiptInput.Type,
    file?: File,
  ): Effect.Effect<void, InternalSdkError>;
  delete(id: number): Effect.Effect<void, InternalSdkError>;

  submit(
    input: typeof ReceiptSubmitInput.Type,
    file: File,
  ): Effect.Effect<typeof ReceiptCommandObservation.Type, InternalSdkError>;
  revise(
    receiptId: typeof ReceiptId.Type,
    expectedRevision: typeof ReceiptRevision.Type,
    input: typeof ReceiptReviseInput.Type,
    replacementFile?: File,
  ): Effect.Effect<typeof ReceiptCommandObservation.Type, InternalSdkError>;
  withdraw(
    receiptId: typeof ReceiptId.Type,
    expectedRevision: typeof ReceiptRevision.Type,
    commandId: typeof CommandId.Type,
  ): Effect.Effect<typeof ReceiptCommandObservation.Type, InternalSdkError>;
  listOwned(
    filter?: typeof ReceiptOwnerFilter.Type,
  ): Effect.Effect<typeof ReceiptPage.Type, InternalSdkError>;
  listForApproval(
    filter?: typeof ReceiptApprovalFilter.Type,
  ): Effect.Effect<typeof ReceiptPage.Type, InternalSdkError>;
  refund(
    receiptId: typeof ReceiptId.Type,
    expectedRevision: typeof ReceiptRevision.Type,
    commandId: typeof CommandId.Type,
  ): Effect.Effect<typeof ReceiptCommandObservation.Type, InternalSdkError>;
  reject(
    receiptId: typeof ReceiptId.Type,
    expectedRevision: typeof ReceiptRevision.Type,
    commandId: typeof CommandId.Type,
  ): Effect.Effect<typeof ReceiptCommandObservation.Type, InternalSdkError>;
}

export function createReceiptsDomain(transport: Transport): ReceiptsDomain {
  return {
    list(params) {
      const query: Record<string, string | number | undefined> = {};
      if (params?.status !== undefined) query.status = params.status;
      if (params?.page !== undefined) query.page = params.page;
      if (params?.pageSize !== undefined) query.itemsPerPage = params.pageSize;
      return transport.getCollection("/api/receipts", Receipt, query);
    },

    create(input, file) {
      if (file) {
        const formData = new FormData();
        formData.append("description", input.description);
        formData.append("sum", String(input.sum));
        formData.append("receiptDate", input.receiptDate);
        formData.append("file", file);
        return transport.postFormData("/api/receipts", formData, ReceiptCreateResponse);
      }
      return transport.post("/api/receipts", input, ReceiptCreateResponse);
    },

    update(id, input, file) {
      if (file) {
        const formData = new FormData();
        formData.append("description", input.description);
        formData.append("sum", String(input.sum));
        formData.append("receiptDate", input.receiptDate);
        formData.append("file", file);
        return transport.postFormDataVoid(`/api/receipts/${id}`, formData);
      }
      return transport.put(`/api/receipts/${id}`, input);
    },

    delete(id) {
      return transport.del(`/api/receipts/${id}`);
    },

    submit(input, file) {
      return decodeCanonical(ReceiptSubmitInput, input).pipe(
        Effect.flatMap((validInput) => {
          if (!isBrowserFile(file)) return Effect.fail(new ReceiptDecodeError());

          const formData = new FormData();
          formData.append("commandId", validInput.commandId);
          formData.append("description", validInput.description);
          formData.append("amountOre", String(validInput.amountOre));
          formData.append("receiptDate", validInput.receiptDate);
          formData.append("file", file);
          return transport.postFormData(
            "/api/receipts/submit",
            formData,
            ReceiptCommandObservation,
            { strict: true },
          );
        }),
      );
    },

    revise(receiptId, expectedRevision, input, replacementFile) {
      return decodeCanonical(ReceiptId, receiptId).pipe(
        Effect.flatMap((validReceiptId) =>
          decodeCanonical(ReceiptRevision, expectedRevision).pipe(
            Effect.flatMap((validRevision) =>
              decodeCanonical(ReceiptReviseInput, input).pipe(
                Effect.flatMap((validInput) => {
                  if (replacementFile !== undefined && !isBrowserFile(replacementFile)) {
                    return Effect.fail(new ReceiptDecodeError());
                  }

                  const formData = new FormData();
                  formData.append("commandId", validInput.commandId);
                  formData.append("expectedRevision", String(validRevision));
                  formData.append("description", validInput.description);
                  formData.append("amountOre", String(validInput.amountOre));
                  formData.append("receiptDate", validInput.receiptDate);
                  if (replacementFile !== undefined) formData.append("file", replacementFile);

                  return transport.postFormData(
                    `/api/receipts/${encodeURIComponent(validReceiptId)}/revise`,
                    formData,
                    ReceiptCommandObservation,
                    { strict: true },
                  );
                }),
              ),
            ),
          ),
        ),
      );
    },

    withdraw(receiptId, expectedRevision, commandId) {
      return decodeCanonical(ReceiptId, receiptId).pipe(
        Effect.flatMap((validReceiptId) =>
          decodeCanonical(ReceiptRevision, expectedRevision).pipe(
            Effect.flatMap((validRevision) =>
              decodeCanonical(ReceiptWithdrawInput, {
                commandId,
                expectedRevision: validRevision,
              }).pipe(
                Effect.flatMap((validInput) =>
                  transport.post(
                    `/api/receipts/${encodeURIComponent(validReceiptId)}/withdraw`,
                    validInput,
                    ReceiptCommandObservation,
                    { strict: true },
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    },

    listOwned(filter) {
      return decodeCanonical(ReceiptOwnerFilter, filter ?? {}).pipe(
        Effect.flatMap((validFilter) =>
          transport.get("/api/receipts", ReceiptPage, receiptQuery(validFilter), { strict: true }),
        ),
      );
    },

    listForApproval(filter) {
      return decodeCanonical(ReceiptApprovalFilter, filter ?? {}).pipe(
        Effect.flatMap((validFilter) =>
          transport.get("/api/admin/receipts", ReceiptPage, approvalReceiptQuery(validFilter), {
            strict: true,
          }),
        ),
      );
    },

    refund(receiptId, expectedRevision, commandId) {
      return decodeCanonical(ReceiptId, receiptId).pipe(
        Effect.flatMap((validReceiptId) =>
          decodeCanonical(ReceiptResolutionInput, {
            commandId,
            expectedRevision,
          }).pipe(
            Effect.flatMap((validInput) =>
              transport.post(
                `/api/admin/receipts/${encodeURIComponent(validReceiptId)}/refund`,
                validInput,
                ReceiptCommandObservation,
                { strict: true },
              ),
            ),
          ),
        ),
      );
    },

    reject(receiptId, expectedRevision, commandId) {
      return decodeCanonical(ReceiptId, receiptId).pipe(
        Effect.flatMap((validReceiptId) =>
          decodeCanonical(ReceiptResolutionInput, {
            commandId,
            expectedRevision,
          }).pipe(
            Effect.flatMap((validInput) =>
              transport.post(
                `/api/admin/receipts/${encodeURIComponent(validReceiptId)}/reject`,
                validInput,
                ReceiptCommandObservation,
                { strict: true },
              ),
            ),
          ),
        ),
      );
    },
  };
}
