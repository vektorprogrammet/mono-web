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
  type ReceiptUiError,
  type ReceiptUiErrorField,
} from "@/lib/receipt-view";
import {
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.mine-utlegg._index";

const MAX_FILE_BYTES = 10_485_760;
const MAX_AMOUNT_ORE = 9_007_199_254_740_991n;
const SUPPORTED_FILE_TYPES: Record<string, true> = {
  "application/pdf": true,
  "image/jpeg": true,
  "image/png": true,
};

type ParseResult<T> = { value: T } | { error: ReceiptUiError };

type ParsedReceiptSubmission = {
  input: {
    commandId: string;
    description: string;
    amountOre: number;
    receiptDate: string;
  };
  file: File;
};

function readFormText(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function receiptDecodeError(
  message: string,
  field?: ReceiptUiErrorField,
): ReceiptUiError {
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
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function parseReceiptSubmission(
  form: FormData,
): ParseResult<ParsedReceiptSubmission> {
  const description = readFormText(form, "description")?.trim() ?? "";
  if (description.length === 0) {
    return {
      error: receiptDecodeError(
        "Beskrivelse er påkrevd.",
        "description",
      ),
    };
  }
  if (description.length > 5000) {
    return {
      error: receiptDecodeError(
        "Beskrivelse kan ikke være lengre enn 5 000 tegn.",
        "description",
      ),
    };
  }

  const amountValue = readFormText(form, "amountNok");
  const amountOre =
    amountValue === null ? undefined : parseAmountOre(amountValue);
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
      error: receiptDecodeError(
        "Velg en gyldig kalenderdato.",
        "receiptDate",
      ),
    };
  }

  const fileValue = form.get("file");
  if (!(fileValue instanceof File) || fileValue.size === 0) {
    return {
      error: receiptDecodeError("Kvitteringsfil er påkrevd.", "file"),
    };
  }
  if (SUPPORTED_FILE_TYPES[fileValue.type] !== true) {
    return {
      error: receiptDecodeError(
        "Kvitteringsfilen må være PDF, PNG eller JPEG.",
        "file",
      ),
    };
  }
  if (fileValue.size > MAX_FILE_BYTES) {
    return {
      error: receiptDecodeError(
        "Kvitteringsfilen kan ikke være større enn 10 MiB.",
        "file",
      ),
    };
  }

  const suppliedCommandId = readFormText(form, "commandId")?.trim() ?? "";
  const commandId =
    suppliedCommandId.length > 0 ? suppliedCommandId : crypto.randomUUID();

  return {
    value: {
      input: {
        commandId,
        description,
        amountOre,
        receiptDate,
      },
      file: fileValue,
    },
  };
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
      throw redirect("/login?expired=true");
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

  if (readFormText(form, "_intent") !== "submit") {
    return {
      success: false as const,
      error: receiptDecodeError("Ukjent handling."),
    };
  }

  const parsed = parseReceiptSubmission(form);
  if ("error" in parsed) {
    return { success: false as const, error: parsed.error };
  }

  try {
    const observation = await client.receipts.submit(
      parsed.value.input,
      parsed.value.file,
    );
    const submission: ReceiptSubmissionNotice = {
      commandId: observation.commandId,
      receiptId: observation.receiptId,
      replayed: observation.replayed,
    };
    return { success: true as const, submission };
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw redirect("/login?expired=true");
    }
    return {
      success: false as const,
      error: mapOwnedReceiptError(error),
    };
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function MineUtlegg() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const actionError =
    actionData?.success === false ? actionData.error : undefined;
  const submission =
    actionData?.success === true ? actionData.submission : undefined;

  return (
    <section
      className="flex w-full min-w-0 flex-col"
      aria-labelledby="mine-utlegg-title"
    >
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 sm:px-6 lg:px-8">
        <header className="max-w-3xl">
          <h1 id="mine-utlegg-title" className="font-semibold text-2xl">
            Mine Utlegg
          </h1>
          <p className="mt-2 text-muted-foreground">
            Send inn kvitteringen din og følg behandlingsstatusen her.
          </p>
        </header>

        <ReceiptSubmitForm
          error={actionError}
          submission={submission}
        />

        <OwnedReceiptList
          receipts={loaderData.receipts}
          error={loaderData.error}
          busy={navigation.state === "loading"}
        />
      </div>
    </section>
  );
}
