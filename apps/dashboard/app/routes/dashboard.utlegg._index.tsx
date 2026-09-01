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
import { Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.utlegg._index";

type ParsedApprovalCommand = {
  intent: ReceiptApprovalIntent;
  receiptId: string;
  expectedRevision: number;
  commandId: string;
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
  const receiptId = readFormText(form, "receiptId")?.trim() ?? "";
  const revisionText = readFormText(form, "expectedRevision")?.trim() ?? "";
  const commandId = readFormText(form, "commandId")?.trim() ?? "";
  const decodedRevision = /^(0|[1-9]\d*)$/.test(revisionText) ? Number(revisionText) : Number.NaN;
  const expectedRevision = Number.isSafeInteger(decodedRevision) ? decodedRevision : 0;

  if (receiptId.length === 0) {
    return {
      failure: {
        intent,
        receiptId,
        expectedRevision,
        commandId,
        error: {
          _tag: "ReceiptDecodeError",
          message: "Utleggs-ID mangler. Last inn siden på nytt og prøv igjen.",
        },
      },
    };
  }

  if (!Number.isSafeInteger(decodedRevision)) {
    return {
      failure: {
        intent,
        receiptId,
        expectedRevision,
        commandId,
        error: {
          _tag: "ReceiptDecodeError",
          message: "Utleggsversjonen er ugyldig. Last inn siden på nytt og prøv igjen.",
        },
      },
    };
  }

  if (commandId.length === 0) {
    return {
      failure: {
        intent,
        receiptId,
        expectedRevision,
        commandId,
        error: {
          _tag: "ReceiptDecodeError",
          message: "Handlings-ID mangler. Åpne bekreftelsen på nytt og prøv igjen.",
        },
      },
    };
  }

  return {
    value: { intent, receiptId, expectedRevision, commandId },
  };
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
    const result = await client.receipts.listForApproval(status ? { status } : undefined);
    return {
      receipts: result.items.map(mapApprovalReceiptView),
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
    const observation =
      command.intent === "refund"
        ? await client.receipts.refund(
            command.receiptId,
            command.expectedRevision,
            command.commandId,
          )
        : await client.receipts.reject(
            command.receiptId,
            command.expectedRevision,
            command.commandId,
          );

    return {
      success: true as const,
      actionNotice: {
        intent: command.intent,
        commandId: observation.commandId,
        receiptId: observation.receiptId,
        status: observation.status,
        revision: observation.revision,
        replayed: observation.replayed,
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
