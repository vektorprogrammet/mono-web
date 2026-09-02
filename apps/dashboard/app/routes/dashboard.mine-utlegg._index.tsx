import { OwnedReceiptList } from "@/components/receipts/OwnedReceiptList";
import {
  ReceiptSubmitForm,
  type ReceiptSubmissionNotice,
} from "@/components/receipts/ReceiptSubmitForm";
import {
  isUnauthorizedError,
  mapOwnedReceiptError,
  mapOwnedReceiptView,
  type OwnedReceiptView,
  type ReceiptOwnerMutationFailure,
  type ReceiptOwnerMutationNotice,
  type ReceiptRevisionDraft,
  type ReceiptUiError,
  type ReceiptUiErrorField,
} from "@/lib/receipt-view";
import { ReceiptId } from "@vektorprogrammet/domain/receipt";
import {
  IdempotencyKey,
  StrongETag,
  type IdempotencyKey as IdempotencyKeyValue,
  type StrongETag as StrongETagValue,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.mine-utlegg._index";

const MAX_FILE_BYTES = 10_485_760;
const MAX_AMOUNT_ORE = 9_007_199_254_740_991n;
const SUPPORTED_FILE_TYPES: Record<string, true> = {
  "application/pdf": true,
  "image/jpeg": true,
  "image/png": true,
};

type ParseResult<T> = { value: T } | { error: ReceiptUiError };

type ParsedReceiptFields = {
  payload: {
    description: string;
    amountOre: number;
    receiptDate: string;
  };
  draft: ReceiptRevisionDraft;
};

type ParsedReceiptIdentity = {
  receiptId: typeof ReceiptId.Type;
  etag: StrongETagValue;
};

function readFormText(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function receiptDecodeError(message: string, field?: ReceiptUiErrorField): ReceiptUiError {
  return { _tag: "ReceiptDecodeError", message, field };
}

function decodeIdempotencyKey(value: string): IdempotencyKeyValue | undefined {
  try {
    return Schema.decodeUnknownSync(IdempotencyKey)(value);
  } catch {
    return undefined;
  }
}

function parseAmountOre(value: string): number | undefined {
  const match = /^(0|[1-9]\d*)(?:[,.](\d{1,2}))?$/.exec(value.trim());
  if (match === null) return undefined;

  const wholeOre = BigInt(match[1]) * 100n;
  const fractionalOre = BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  const amountOre = wholeOre + fractionalOre;
  if (amountOre <= 0n || amountOre > MAX_AMOUNT_ORE) return undefined;

  return Number(amountOre);
}

function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseReceiptFields(form: FormData): ParseResult<ParsedReceiptFields> {
  const description = readFormText(form, "description")?.trim() ?? "";
  if (description.length === 0) {
    return {
      error: receiptDecodeError("Beskrivelse er påkrevd.", "description"),
    };
  }
  if (description.length > 5000) {
    return {
      error: receiptDecodeError("Beskrivelse kan ikke være lengre enn 5 000 tegn.", "description"),
    };
  }

  const amountNok = readFormText(form, "amountNok")?.trim() ?? "";
  const amountOre = parseAmountOre(amountNok);
  if (amountOre === undefined) {
    return {
      error: receiptDecodeError(
        "Beløpet må være positivt og ha maksimalt to desimaler.",
        "amountNok",
      ),
    };
  }

  const receiptDate = readFormText(form, "receiptDate") ?? "";
  if (!isRealCalendarDate(receiptDate)) {
    return {
      error: receiptDecodeError("Velg en gyldig kalenderdato.", "receiptDate"),
    };
  }

  return {
    value: {
      payload: {
        description,
        amountOre,
        receiptDate,
      },
      draft: {
        description,
        amountNok,
        receiptDate,
      },
    },
  };
}

function parseReceiptIdentity(form: FormData): ParseResult<ParsedReceiptIdentity> {
  try {
    return {
      value: {
        receiptId: Schema.decodeUnknownSync(ReceiptId)(
          readFormText(form, "receiptId")?.trim() ?? "",
        ),
        etag: Schema.decodeUnknownSync(StrongETag)(readFormText(form, "etag")?.trim() ?? ""),
      },
    };
  } catch {
    return {
      error: receiptDecodeError(
        "Utleggsidentiteten er ugyldig. Last inn siden på nytt og prøv igjen.",
      ),
    };
  }
}

function parseReceiptFile(form: FormData, required: true): ParseResult<File>;
function parseReceiptFile(form: FormData, required: false): ParseResult<File | undefined>;
function parseReceiptFile(form: FormData, required: boolean): ParseResult<File | undefined> {
  const fileValue = form.get("file");
  if (!(fileValue instanceof File) || fileValue.size === 0) {
    return required
      ? { error: receiptDecodeError("Kvitteringsfil er påkrevd.", "file") }
      : { value: undefined };
  }
  if (SUPPORTED_FILE_TYPES[fileValue.type] !== true) {
    return {
      error: receiptDecodeError("Kvitteringsfilen må være PDF, PNG eller JPEG.", "file"),
    };
  }
  if (fileValue.size > MAX_FILE_BYTES) {
    return {
      error: receiptDecodeError("Kvitteringsfilen kan ikke være større enn 10 MiB.", "file"),
    };
  }

  return { value: fileValue };
}

function receiptMultipartPayload(
  fields: ParsedReceiptFields["payload"],
  file: File | undefined,
): FormData {
  const payload = new FormData();
  payload.set("description", fields.description);
  payload.set("amountOre", String(fields.amountOre));
  payload.set("receiptDate", fields.receiptDate);
  if (file !== undefined) payload.set("file", file);
  return payload;
}

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  try {
    const result = await client.receipts.listReceipts({ query: {} });
    return {
      receipts: result.body.items.map(mapOwnedReceiptView),
      error: undefined,
    };
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw await expiredSessionRedirect(request);
    }
    return {
      receipts: [] as OwnedReceiptView[],
      error: mapOwnedReceiptError(error),
    };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const form = await request.formData();
  const commandIdText = readFormText(form, "commandId")?.trim() || crypto.randomUUID();
  const commandId = decodeIdempotencyKey(commandIdText);
  const intent = readFormText(form, "_intent");
  const draft: ReceiptRevisionDraft = {
    description: readFormText(form, "description") ?? "",
    amountNok: readFormText(form, "amountNok") ?? "",
    receiptDate: readFormText(form, "receiptDate") ?? "",
  };

  if (intent === "submit") {
    if (commandId === undefined) {
      return {
        success: false as const,
        intent,
        commandId: commandIdText,
        error: receiptDecodeError("Handlings-ID-en er ugyldig. Prøv å sende inn på nytt."),
        draft,
      };
    }
    const fields = parseReceiptFields(form);
    if ("error" in fields) {
      return {
        success: false as const,
        intent,
        commandId: commandIdText,
        error: fields.error,
        draft,
      };
    }

    const file = parseReceiptFile(form, true);
    if ("error" in file) {
      return {
        success: false as const,
        intent,
        commandId: commandIdText,
        error: file.error,
        draft,
      };
    }

    try {
      const result = await client.receipts.submitReceipt({
        query: {},
        headers: { "idempotency-key": commandId },
        payload: receiptMultipartPayload(fields.value.payload, file.value),
      });
      const submission: ReceiptSubmissionNotice = {
        commandId: commandIdText,
        receiptId: result.body.receiptId,
        etag: result.body.etag,
      };
      return { success: true as const, intent, submission };
    } catch (error) {
      if (isUnauthorizedError(error)) {
        throw await expiredSessionRedirect(request);
      }
      return {
        success: false as const,
        intent,
        commandId: commandIdText,
        error: mapOwnedReceiptError(error),
        draft,
      };
    }
  }

  if (intent === "revise") {
    const identity = parseReceiptIdentity(form);
    if ("error" in identity || commandId === undefined) {
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        receiptId: readFormText(form, "receiptId")?.trim() ?? "",
        commandId: commandIdText,
        error:
          "error" in identity
            ? identity.error
            : receiptDecodeError("Handlings-ID-en er ugyldig. Åpne redigeringen på nytt."),
      };
      return { success: false as const, intent, mutationFailure };
    }

    const fields = parseReceiptFields(form);
    if ("error" in fields) {
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        ...identity.value,
        commandId: commandIdText,
        error: fields.error,
      };
      return { success: false as const, intent, mutationFailure };
    }

    const replacementFile = parseReceiptFile(form, false);
    if ("error" in replacementFile) {
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        ...identity.value,
        commandId: commandIdText,
        error: replacementFile.error,
        draft: fields.value.draft,
      };
      return { success: false as const, intent, mutationFailure };
    }

    try {
      const result = await client.receipts.reviseReceipt({
        params: { receiptId: identity.value.receiptId },
        headers: {
          "idempotency-key": commandId,
          "if-match": identity.value.etag,
        },
        payload: receiptMultipartPayload(fields.value.payload, replacementFile.value),
      });
      const mutationNotice: ReceiptOwnerMutationNotice = {
        intent,
        commandId: commandIdText,
        receiptId: result.body.receiptId,
        status: result.body.status,
        revision: result.body.revision,
        etag: result.body.etag,
      };
      return { success: true as const, intent, mutationNotice };
    } catch (error) {
      if (isUnauthorizedError(error)) {
        throw await expiredSessionRedirect(request);
      }
      const mappedError = mapOwnedReceiptError(error);
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        ...identity.value,
        commandId:
          mappedError._tag === "StaleReceiptRevision" ? crypto.randomUUID() : commandIdText,
        error: mappedError,
        ...(mappedError._tag === "StaleReceiptRevision" ? {} : { draft: fields.value.draft }),
      };
      return { success: false as const, intent, mutationFailure };
    }
  }

  if (intent === "withdraw") {
    const identity = parseReceiptIdentity(form);
    if ("error" in identity || commandId === undefined) {
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        receiptId: readFormText(form, "receiptId")?.trim() ?? "",
        commandId: commandIdText,
        error:
          "error" in identity
            ? identity.error
            : receiptDecodeError("Handlings-ID-en er ugyldig. Åpne bekreftelsen på nytt."),
      };
      return { success: false as const, intent, mutationFailure };
    }

    try {
      const result = await client.receipts.withdrawReceipt({
        params: { receiptId: identity.value.receiptId },
        headers: {
          "idempotency-key": commandId,
          "if-match": identity.value.etag,
        },
        payload: {},
      });
      const mutationNotice: ReceiptOwnerMutationNotice = {
        intent,
        commandId: commandIdText,
        receiptId: result.body.receiptId,
        status: result.body.status,
        revision: result.body.revision,
        etag: result.body.etag,
      };
      return { success: true as const, intent, mutationNotice };
    } catch (error) {
      if (isUnauthorizedError(error)) {
        throw await expiredSessionRedirect(request);
      }
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        ...identity.value,
        commandId: commandIdText,
        error: mapOwnedReceiptError(error),
      };
      return { success: false as const, intent, mutationFailure };
    }
  }

  return {
    success: false as const,
    intent: "submit" as const,
    commandId: commandIdText,
    error: receiptDecodeError("Ukjent handling."),
  };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function MineUtlegg() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submissionError =
    actionData?.success === false && actionData.intent === "submit" ? actionData.error : undefined;
  const submission =
    actionData?.success === true && actionData.intent === "submit"
      ? actionData.submission
      : undefined;
  const submissionCommandId =
    actionData?.success === false && actionData.intent === "submit"
      ? actionData.commandId
      : undefined;
  const submissionDraft =
    actionData?.success === false && actionData.intent === "submit" ? actionData.draft : undefined;
  const mutationFailure =
    actionData?.success === false &&
    (actionData.intent === "revise" || actionData.intent === "withdraw")
      ? actionData.mutationFailure
      : undefined;
  const mutationNotice =
    actionData?.success === true &&
    (actionData.intent === "revise" || actionData.intent === "withdraw")
      ? actionData.mutationNotice
      : undefined;

  return (
    <section className="flex w-full min-w-0 flex-col" aria-labelledby="mine-utlegg-title">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 sm:px-6 lg:px-8">
        <header className="max-w-3xl">
          <h1 id="mine-utlegg-title" className="font-semibold text-2xl">
            Mine Utlegg
          </h1>
          <p className="mt-2 text-muted-foreground">
            Send inn kvitteringen din, og administrer utlegg som venter på behandling.
          </p>
        </header>

        <ReceiptSubmitForm
          error={submissionError}
          submission={submission}
          commandId={submissionCommandId}
          draft={submissionDraft}
        />

        <OwnedReceiptList
          receipts={loaderData.receipts}
          error={loaderData.error}
          mutationFailure={mutationFailure}
          mutationNotice={mutationNotice}
          busy={navigation.state !== "idle"}
        />
      </div>
    </section>
  );
}
