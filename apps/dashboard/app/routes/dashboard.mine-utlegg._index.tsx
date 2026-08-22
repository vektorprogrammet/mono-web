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
  input: {
    commandId: string;
    description: string;
    amountOre: number;
    receiptDate: string;
  };
  draft: ReceiptRevisionDraft;
};

type ParsedReceiptIdentity = {
  receiptId: string;
  expectedRevision: number;
};

function readFormText(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function receiptDecodeError(message: string, field?: ReceiptUiErrorField): ReceiptUiError {
  return { _tag: "ReceiptDecodeError", message, field };
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

function parseReceiptFields(form: FormData, commandId: string): ParseResult<ParsedReceiptFields> {
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
      input: {
        commandId,
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
  const receiptId = readFormText(form, "receiptId")?.trim() ?? "";
  if (receiptId.length === 0) {
    return {
      error: receiptDecodeError("Utleggs-ID mangler. Last inn siden på nytt og prøv igjen."),
    };
  }

  const revisionValue = readFormText(form, "expectedRevision")?.trim() ?? "";
  if (!/^(0|[1-9]\d*)$/.test(revisionValue)) {
    return {
      error: receiptDecodeError("Utleggsversjonen er ugyldig. Last inn siden på nytt og prøv igjen."),
    };
  }
  const expectedRevision = Number(revisionValue);
  if (!Number.isSafeInteger(expectedRevision)) {
    return {
      error: receiptDecodeError("Utleggsversjonen er ugyldig. Last inn siden på nytt og prøv igjen."),
    };
  }

  return { value: { receiptId, expectedRevision } };
}

function parseReceiptFile(form: FormData, required: true): ParseResult<File>;
function parseReceiptFile(form: FormData, required: false): ParseResult<File | undefined>;
function parseReceiptFile(
  form: FormData,
  required: boolean,
): ParseResult<File | undefined> {
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

export async function loader({ request }: Route.LoaderArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);

  try {
    const result = await client.receipts.listOwned();
    return {
      receipts: result.items.map(mapOwnedReceiptView),
      error: undefined,
    };
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw expiredSessionRedirect();
    }
    return {
      receipts: [] as OwnedReceiptView[],
      error: mapOwnedReceiptError(error),
    };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const form = await request.formData();
  const commandId = readFormText(form, "commandId")?.trim() || crypto.randomUUID();
  const intent = readFormText(form, "_intent");

  if (intent === "submit") {
    const fields = parseReceiptFields(form, commandId);
    if ("error" in fields) {
      return {
        success: false as const,
        intent: "submit" as const,
        commandId,
        error: fields.error,
      };
    }

    const file = parseReceiptFile(form, true);
    if ("error" in file) {
      return {
        success: false as const,
        intent: "submit" as const,
        commandId,
        error: file.error,
      };
    }

    try {
      const observation = await client.receipts.submit(fields.value.input, file.value);
      const submission: ReceiptSubmissionNotice = {
        commandId: observation.commandId,
        receiptId: observation.receiptId,
        replayed: observation.replayed,
      };
      return { success: true as const, intent: "submit" as const, submission };
    } catch (error) {
      if (isUnauthorizedError(error)) {
        throw expiredSessionRedirect();
      }
      return {
        success: false as const,
        intent: "submit" as const,
        commandId,
        error: mapOwnedReceiptError(error),
      };
    }
  }

  if (intent === "revise") {
    const identity = parseReceiptIdentity(form);
    if ("error" in identity) {
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        receiptId: readFormText(form, "receiptId")?.trim() ?? "",
        expectedRevision: 0,
        commandId,
        error: identity.error,
      };
      return { success: false as const, intent, mutationFailure };
    }

    const fields = parseReceiptFields(form, commandId);
    if ("error" in fields) {
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        ...identity.value,
        commandId,
        error: fields.error,
      };
      return { success: false as const, intent, mutationFailure };
    }

    const replacementFile = parseReceiptFile(form, false);
    if ("error" in replacementFile) {
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        ...identity.value,
        commandId,
        error: replacementFile.error,
        draft: fields.value.draft,
      };
      return { success: false as const, intent, mutationFailure };
    }

    try {
      const observation =
        replacementFile.value === undefined
          ? await client.receipts.revise(
              identity.value.receiptId,
              identity.value.expectedRevision,
              fields.value.input,
            )
          : await client.receipts.revise(
              identity.value.receiptId,
              identity.value.expectedRevision,
              fields.value.input,
              replacementFile.value,
            );
      const mutationNotice: ReceiptOwnerMutationNotice = {
        intent,
        commandId: observation.commandId,
        receiptId: observation.receiptId,
        status: observation.status,
        revision: observation.revision,
        replayed: observation.replayed,
      };
      return { success: true as const, intent, mutationNotice };
    } catch (error) {
      if (isUnauthorizedError(error)) {
        throw expiredSessionRedirect();
      }
      const mappedError = mapOwnedReceiptError(error);
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        ...identity.value,
        commandId,
        error: mappedError,
        ...(mappedError._tag === "StaleReceiptRevision" ? {} : { draft: fields.value.draft }),
      };
      return { success: false as const, intent, mutationFailure };
    }
  }

  if (intent === "withdraw") {
    const identity = parseReceiptIdentity(form);
    if ("error" in identity) {
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        receiptId: readFormText(form, "receiptId")?.trim() ?? "",
        expectedRevision: 0,
        commandId,
        error: identity.error,
      };
      return { success: false as const, intent, mutationFailure };
    }

    try {
      const observation = await client.receipts.withdraw(
        identity.value.receiptId,
        identity.value.expectedRevision,
        commandId,
      );
      const mutationNotice: ReceiptOwnerMutationNotice = {
        intent,
        commandId: observation.commandId,
        receiptId: observation.receiptId,
        status: observation.status,
        revision: observation.revision,
        replayed: observation.replayed,
      };
      return { success: true as const, intent, mutationNotice };
    } catch (error) {
      if (isUnauthorizedError(error)) {
        throw expiredSessionRedirect();
      }
      const mutationFailure: ReceiptOwnerMutationFailure = {
        intent,
        ...identity.value,
        commandId,
        error: mapOwnedReceiptError(error),
      };
      return { success: false as const, intent, mutationFailure };
    }
  }

  return {
    success: false as const,
    intent: "submit" as const,
    commandId,
    error: receiptDecodeError("Ukjent handling."),
  };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function MineUtlegg() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submissionError =
    actionData?.success === false && actionData.intent === "submit"
      ? actionData.error
      : undefined;
  const submission =
    actionData?.success === true && actionData.intent === "submit"
      ? actionData.submission
      : undefined;
  const submissionCommandId =
    actionData?.success === false && actionData.intent === "submit"
      ? actionData.commandId
      : undefined;
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
