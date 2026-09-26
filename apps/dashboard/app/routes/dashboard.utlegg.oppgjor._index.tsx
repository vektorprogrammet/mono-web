import { ReceiptPagination } from "@/components/receipts/ReceiptPagination";
import { Predicate } from "effect";
import { SettlementReceiptList } from "@/components/receipts/SettlementReceiptList";
import { Button } from "@/components/ui/button";
import {
  isUnauthorizedError,
  mapReceiptSettlementEvidenceView,
  mapApprovalReceiptError,
  mapSettlementReceiptView,
  type ReceiptSettlementFailure,
  type ReceiptSettlementNotice,
  ReceiptUiError,
} from "@/lib/receipt-view";
import {
  IdempotencyKey,
  ReceiptId,
  RecordReceiptSettlementRequest,
  StrongETag,
  type IdempotencyKey as IdempotencyKeyValue,
  type StrongETag as StrongETagValue,
} from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { Link, useActionData, useLoaderData, useNavigation } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.utlegg.oppgjor._index";

type ParsedSettlementCommand = {
  receiptId: ReceiptId;
  etag: StrongETagValue;
  commandId: IdempotencyKeyValue;
  payload: typeof RecordReceiptSettlementRequest.Type;
};

type SettlementCommandParseResult =
  | { value: ParsedSettlementCommand }
  | { failure: ReceiptSettlementFailure };

function readFormText(form: FormData, name: string): string | null {
  const value = form.get(name);

  return Predicate.isString(value) ? value : null;
}

function utcInstantFromInput(value: string): string | undefined {
  const trimmed = value.trim();
  const localMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/.exec(trimmed);

  const candidate =
    localMatch === null ? trimmed : `${localMatch[1]}:${localMatch[2] ?? "00"}.000Z`;

  const date = new Date(candidate);

  if (Number.isNaN(date.getTime())) return undefined;

  if (
    localMatch !== null &&
    date.toISOString().slice(0, 19) !== `${localMatch[1]}:${localMatch[2] ?? "00"}`
  ) {
    return undefined;
  }

  return date.toISOString();
}

function parseSettlementCommand(form: FormData): SettlementCommandParseResult {
  const receiptIdText = readFormText(form, "receiptId")?.trim() ?? "";
  const etagText = readFormText(form, "etag")?.trim() ?? "";
  const commandIdText = readFormText(form, "commandId")?.trim() ?? "";
  const expectedRevisionText = readFormText(form, "expectedRevision")?.trim() ?? "";
  const externalAuthority = readFormText(form, "externalAuthority")?.trim() ?? "";
  const externalReference = readFormText(form, "externalReference")?.trim() ?? "";
  const settledAtInput = readFormText(form, "settledAt")?.trim() ?? "";
  const settledAt = utcInstantFromInput(settledAtInput);
  const expectedRevision = Number(expectedRevisionText);
  let etag: StrongETagValue | undefined;

  try {
    etag = Schema.decodeSync(StrongETag)(etagText);
  } catch {
    etag = undefined;
  }

  const failure = (error: ReceiptUiError): SettlementCommandParseResult => ({
    failure: {
      receiptId: receiptIdText,
      etag: etag === undefined ? undefined : etag,
      commandId: commandIdText,
      externalAuthority,
      externalReference,
      settledAt: settledAtInput,
      error,
    },
  });

  if (externalAuthority.length === 0) {
    return failure(
      ReceiptUiError.ReceiptDecodeError({
        message: "Ekstern autoritet er påkrevd.",
        field: "externalAuthority",
      }),
    );
  }

  if (externalReference.length === 0) {
    return failure(
      ReceiptUiError.ReceiptDecodeError({
        message: "Ekstern referanse er påkrevd.",
        field: "externalReference",
      }),
    );
  }

  if (settledAt === undefined) {
    return failure(
      ReceiptUiError.ReceiptDecodeError({
        message: "Oppgi et gyldig oppgjørstidspunkt i UTC.",
        field: "settledAt",
      }),
    );
  }

  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return failure(
      ReceiptUiError.ReceiptDecodeError({
        message: "Utleggsversjonen er ugyldig. Åpne oppgjøret på nytt og prøv igjen.",
      }),
    );
  }

  try {
    return {
      value: {
        receiptId: Schema.decodeSync(ReceiptId)(receiptIdText),
        etag: Schema.decodeSync(StrongETag)(etagText),
        commandId: Schema.decodeSync(IdempotencyKey)(commandIdText),
        payload: Schema.decodeSync(RecordReceiptSettlementRequest)({
          expectedRevision,
          externalAuthority,
          externalReference,
          settledAt,
        }),
      },
    };
  } catch {
    return failure(
      ReceiptUiError.ReceiptDecodeError({
        message: "Oppgjørsgrunnlaget er ugyldig. Åpne oppgjøret på nytt og prøv igjen.",
      }),
    );
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const cursor = new URL(request.url).searchParams.get("cursor") ?? undefined;

  try {
    const result = await client.receipts.listReceiptsForSettlement({ query: { cursor } });

    return {
      receipts: result.body.items.map(mapSettlementReceiptView),
      nextCursor: result.body.nextCursor,
      error: undefined,
    };
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw await expiredSessionRedirect(request);
    }

    return {
      nextCursor: undefined,
      receipts: [],
      error: mapApprovalReceiptError(error),
    };
  }
}

export async function action({ request }: Route.ActionArgs) {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);
  const form = await request.formData();

  if (readFormText(form, "_intent") !== "settle") {
    const actionError: ReceiptUiError = ReceiptUiError.ReceiptDecodeError({
      message: "Ukjent oppgjørshandling. Åpne bekreftelsen på nytt og prøv igjen.",
    });

    return { success: false as const, actionError };
  }

  const parsed = parseSettlementCommand(form);

  if ("failure" in parsed) {
    return { success: false as const, actionFailure: parsed.failure };
  }

  const command = parsed.value;

  try {
    const result = await client.receipts.settleReceipt({
      params: { receiptId: command.receiptId },
      headers: {
        "idempotency-key": command.commandId,
        "if-match": command.etag,
      },
      payload: command.payload,
    });

    const actionNotice: ReceiptSettlementNotice = {
      commandId: command.commandId,
      settlement: mapReceiptSettlementEvidenceView(result.body),
    };

    return { success: true as const, actionNotice };
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw await expiredSessionRedirect(request);
    }

    return {
      success: false as const,
      actionFailure: {
        ...command,
        externalAuthority: command.payload.externalAuthority,
        externalReference: command.payload.externalReference,
        settledAt: command.payload.settledAt,
        error: mapApprovalReceiptError(error),
      },
    };
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function ReceiptSettlementQueue() {
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
    <section className="flex w-full min-w-0 flex-col" aria-labelledby="receipt-settlement-title">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 sm:px-6 lg:px-8">
        <header className="max-w-3xl">
          <h1 id="receipt-settlement-title" className="font-semibold text-2xl">
            Oppgjør av utlegg
          </h1>
          <p className="mt-2 text-muted-foreground">
            Registrer bare bevis for utlegg som allerede er oppgjort utenfor systemet. Godkjenning
            og oppgjør er separate fakta.
          </p>
          <Button className="mt-4" size="sm" variant="outline" asChild>
            <Link to="/dashboard/utlegg" prefetch="intent">
              Til godkjenning av utlegg
            </Link>
          </Button>
        </header>

        <ReceiptPagination nextCursor={loaderData.nextCursor} busy={navigation.state !== "idle"} />
        <SettlementReceiptList
          receipts={loaderData.receipts}
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
