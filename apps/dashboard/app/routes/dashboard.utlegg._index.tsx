import { ApprovalReceiptList } from "@/components/receipts/ApprovalReceiptList";
import { Button } from "@/components/ui/button";
import {
  isUnauthorizedError,
  mapApprovalReceiptError,
  mapApprovalReceiptView,
  type ApprovalReceiptView,
  type ReceiptApprovalFailure,
  type ReceiptApprovalIntent,
  type ReceiptStatus,
  type ReceiptUiError,
} from "@/lib/receipt-view";
import { ReceiptId } from "@vektorprogrammet/domain/receipt";
import {
  IdempotencyKey,
  StrongETag,
  type IdempotencyKey as IdempotencyKeyValue,
  type StrongETag as StrongETagValue,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.utlegg._index";

type ParsedApprovalCommand = {
  intent: ReceiptApprovalIntent;
  receiptId: typeof ReceiptId.Type;
  etag: StrongETagValue;
  commandId: IdempotencyKeyValue;
};

type ApprovalCommandParseResult =
  | { value: ParsedApprovalCommand }
  | { failure: ReceiptApprovalFailure };

const statusFilters = [
  { status: undefined, label: "Alle" },
  { status: "Pending", label: "Venter" },
  { status: "Refunded", label: "Refundert" },
  { status: "Rejected", label: "Avvist" },
  { status: "Withdrawn", label: "Trukket tilbake" },
] satisfies ReadonlyArray<{ status: ReceiptStatus | undefined; label: string }>;

function readFormText(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function isReceiptStatus(value: string | null): value is ReceiptStatus {
  return (
    value === "Pending" || value === "Refunded" || value === "Rejected" || value === "Withdrawn"
  );
}

function parseApprovalCommand(
  form: FormData,
  intent: ReceiptApprovalIntent,
): ApprovalCommandParseResult {
  const receiptIdText = readFormText(form, "receiptId")?.trim() ?? "";
  const etagText = readFormText(form, "etag")?.trim() ?? "";
  const commandIdText = readFormText(form, "commandId")?.trim() ?? "";
  let etag: StrongETagValue | undefined;
  try {
    etag = Schema.decodeUnknownSync(StrongETag)(etagText);
  } catch {
    etag = undefined;
  }

  const failure = (message: string): ApprovalCommandParseResult => ({
    failure: {
      intent,
      receiptId: receiptIdText,
      ...(etag === undefined ? {} : { etag }),
      commandId: commandIdText,
      error: {
        _tag: "ReceiptDecodeError",
        message,
      },
    },
  });

  try {
    return {
      value: {
        intent,
        receiptId: Schema.decodeUnknownSync(ReceiptId)(receiptIdText),
        etag: Schema.decodeUnknownSync(StrongETag)(etagText),
        commandId: Schema.decodeUnknownSync(IdempotencyKey)(commandIdText),
      },
    };
  } catch {
    return failure("Handlingsgrunnlaget er ugyldig. Åpne bekreftelsen på nytt og prøv igjen.");
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const requestedStatus = new URL(request.url).searchParams.get("status");

  if (requestedStatus !== null && !isReceiptStatus(requestedStatus)) {
    const error: ReceiptUiError = {
      _tag: "ReceiptDecodeError",
      message: "Statusfilteret er ugyldig. Velg en status fra listen.",
    };
    return {
      receipts: [] as ApprovalReceiptView[],
      status: undefined,
      error,
    };
  }

  const status = isReceiptStatus(requestedStatus) ? requestedStatus : undefined;

  try {
    const result = await client.receipts.listReceiptsForApproval({
      query: status === undefined ? {} : { status },
    });
    return {
      receipts: result.body.items.map(mapApprovalReceiptView),
      status,
      error: undefined,
    };
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw await expiredSessionRedirect(request);
    }
    return {
      receipts: [] as ApprovalReceiptView[],
      status,
      error: mapApprovalReceiptError(error),
    };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const form = await request.formData();
  const intentValue = readFormText(form, "_intent");

  if (intentValue !== "refund" && intentValue !== "reject") {
    const actionError: ReceiptUiError = {
      _tag: "ReceiptDecodeError",
      message: "Ukjent behandling. Åpne bekreftelsen på nytt og prøv igjen.",
    };
    return { success: false as const, actionError };
  }

  const parsed = parseApprovalCommand(form, intentValue);
  if ("failure" in parsed) {
    return { success: false as const, actionFailure: parsed.failure };
  }

  const command = parsed.value;

  try {
    const requestInput = {
      params: { receiptId: command.receiptId },
      headers: {
        "idempotency-key": command.commandId,
        "if-match": command.etag,
      },
      payload: {},
    };
    const result =
      command.intent === "refund"
        ? await client.receipts.refundReceipt(requestInput)
        : await client.receipts.rejectReceipt(requestInput);

    return {
      success: true as const,
      actionNotice: {
        intent: command.intent,
        commandId: command.commandId,
        receiptId: result.body.receiptId,
        status: result.body.status,
        revision: result.body.revision,
        etag: result.body.etag,
      },
    };
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw await expiredSessionRedirect(request);
    }
    return {
      success: false as const,
      actionFailure: {
        ...command,
        error: mapApprovalReceiptError(error),
      },
    };
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Utlegg() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const actionError =
    actionData?.success === false && "actionError" in actionData
      ? actionData.actionError
      : undefined;
  const actionFailure =
    actionData?.success === false && "actionFailure" in actionData
      ? actionData.actionFailure
      : undefined;
  const actionNotice = actionData?.success === true ? actionData.actionNotice : undefined;

  return (
    <section className="flex w-full min-w-0 flex-col" aria-labelledby="utlegg-title">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 sm:px-6 lg:px-8">
        <header className="max-w-3xl">
          <h1 id="utlegg-title" className="font-semibold text-2xl">
            Utlegg
          </h1>
          <p className="mt-2 text-muted-foreground">
            Refunder eller avvis ventende utlegg i godkjenningsområdet ditt.
          </p>
        </header>

        <nav aria-label="Filtrer utlegg etter status">
          <ul className="flex flex-wrap gap-2">
            {statusFilters.map((filter) => {
              const active = loaderData.status === filter.status;
              const to =
                filter.status === undefined
                  ? "/dashboard/utlegg"
                  : `/dashboard/utlegg?status=${encodeURIComponent(filter.status)}`;

              return (
                <li key={filter.label}>
                  <Button variant={active ? "default" : "outline"} size="sm" asChild>
                    <Link to={to} prefetch="intent" aria-current={active ? "page" : undefined}>
                      {filter.label}
                    </Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        </nav>

        <ApprovalReceiptList
          receipts={loaderData.receipts}
          status={loaderData.status}
          error={loaderData.error}
          actionError={actionError}
          actionFailure={actionFailure}
          actionNotice={actionNotice}
          busy={navigation.state !== "idle"}
        />
      </div>
    </section>
  );
}
