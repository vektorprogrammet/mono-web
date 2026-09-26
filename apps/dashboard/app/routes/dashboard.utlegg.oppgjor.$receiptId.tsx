import { ReceiptSettlementEvidence } from "@/components/receipts/ReceiptSettlementEvidence";
import { Button } from "@/components/ui/button";
import { isUnauthorizedError, mapReceiptSettlementEvidenceView, mapApprovalReceiptError, ReceiptUiError } from "@/lib/receipt-view";
import { ReceiptId } from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { Link, useLoaderData } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, requireAuth } from "../lib/auth.server";
import type { Route } from "./+types/dashboard.utlegg.oppgjor.$receiptId";

export async function loader({ request, params }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  let receiptId: ReceiptId;

  try {
    receiptId = Schema.decodeSync(ReceiptId)(params.receiptId);
  } catch {
    return {
      evidence: undefined,
      error: ReceiptUiError.ReceiptNotFound({message: "Utlegget ble ikke funnet."}) satisfies ReceiptUiError,
    };
  }

  const client = createAuthenticatedClient(cookie, request);

  try {
    const result = await client.receipts.readReceiptSettlementForFinance({
      params: { receiptId },
    });

    return {
      evidence: mapReceiptSettlementEvidenceView(result.body),
      error: undefined,
    };
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw await expiredSessionRedirect(request);
    }

    return {
      evidence: undefined,
      error: mapApprovalReceiptError(error),
    };
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function ReceiptSettlementEvidencePage() {
  const loaderData = useLoaderData<typeof loader>();

  return (
    <section className="flex w-full min-w-0 flex-col" aria-labelledby="receipt-settlement-evidence-title">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 sm:px-6 lg:px-8">
        <header>
          <h1 id="receipt-settlement-evidence-title" className="font-semibold text-2xl">
            Oppgjørsbevis
          </h1>
          <p className="mt-2 text-muted-foreground">
            Dette er en uforanderlig registrering. Utleggets godkjenningsstatus er et separat
            faktum.
          </p>
        </header>

        {loaderData.error ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
            role="alert"
            data-error-tag={loaderData.error._tag}
          >
            {loaderData.error.message}
          </p>
        ) : loaderData.evidence ? (
          <ReceiptSettlementEvidence evidence={loaderData.evidence} title="Registrert oppgjør" />
        ) : null}

        <div>
          <Button variant="outline" asChild>
            <Link to="/dashboard/utlegg/oppgjor" prefetch="intent">
              Til oppgjørskøen
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
