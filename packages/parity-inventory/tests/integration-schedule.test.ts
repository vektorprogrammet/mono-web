import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { collectC2 } from "../src/effects.js"
import { sha256 } from "../src/canonical.js"
import { createManifestContextFromSnapshots } from "../src/source-manifest.js"
import { scanRootEffect } from "../src/runtime.js"

const put = (root: string, path: string, contents: string): void => {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, contents, "utf8")
}

const contextFor = async (legacyRoot: string, monoRoot: string) => {
  const legacy = await Effect.runPromise(scanRootEffect(legacyRoot, "legacy"))
  const mono = await Effect.runPromise(scanRootEffect(monoRoot, "mono"))
  return createManifestContextFromSnapshots(legacy, mono)
}

const subscriberSource = (namespace: string, className = "ApplicationSubscriber"): string => `<?php
namespace ${namespace};

final class ${className} implements \\Symfony\\Component\\EventDispatcher\\EventSubscriberInterface
{
    private Mailer $mailer;

    public function sendConfirmationMail(): void
    {
        $this->mailer->send(new Message());
    }
}
`

const serviceConfig = (classNames: readonly string[]): string => `services:
${classNames.map((className) => `  ${className}: ~`).join("\n")}
`

test("relocated subscriber notification integrations reconcile by owner and method", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-integration-subscriber-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-integration-subscriber-mono-")
  try {
    const legacyPath = "src/AppBundle/EventSubscriber/ApplicationSubscriber.php"
    const monoPath = "apps/server/src/App/Admission/Infrastructure/Subscriber/ApplicationSubscriber.php"
    const legacyClass = "AppBundle\\EventSubscriber\\ApplicationSubscriber"
    const monoClass = "App\\Admission\\Infrastructure\\Subscriber\\ApplicationSubscriber"
    put(legacyRoot, legacyPath, subscriberSource(legacyClass.slice(0, legacyClass.lastIndexOf("\\"))))
    put(monoRoot, monoPath, subscriberSource(monoClass.slice(0, monoClass.lastIndexOf("\\"))))
    put(legacyRoot, "app/config/services.yml", serviceConfig([legacyClass]))
    put(monoRoot, "apps/server/config/services.yaml", serviceConfig([monoClass]))

    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("integration-subscriber-cross-line"))
    const rows = c2.integrations.rows.filter((row) =>
      row.source_ref_ids.some((ref) => [legacyPath, monoPath].includes(context.sourcePathById.get(ref)?.path ?? "")),
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.status === "covered")).toBe(true)
    const rowIds = new Set(rows.map((row) => row.row_id))
    expect(c2.integrations.links.some((link) =>
      link.relation_kind === "matches" && rowIds.has(link.from_row_id) && rowIds.has(link.to_row_id),
    )).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("relocated subscriber event triggers reconcile by subscriber identity", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-schedule-subscriber-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-schedule-subscriber-mono-")
  try {
    const legacyPath = "src/AppBundle/EventSubscriber/ApplicationSubscriber.php"
    const monoPath = "apps/server/src/App/Admission/Infrastructure/Subscriber/ApplicationSubscriber.php"
    const legacyClass = "AppBundle\\EventSubscriber\\ApplicationSubscriber"
    const monoClass = "App\\Admission\\Infrastructure\\Subscriber\\ApplicationSubscriber"
    put(legacyRoot, legacyPath, subscriberSource(legacyClass.slice(0, legacyClass.lastIndexOf("\\"))))
    put(monoRoot, monoPath, subscriberSource(monoClass.slice(0, monoClass.lastIndexOf("\\"))))
    put(legacyRoot, "app/config/services.yml", serviceConfig([legacyClass]))
    put(monoRoot, "apps/server/config/services.yaml", serviceConfig([monoClass]))

    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("schedule-subscriber-cross-line"))
    const rows = c2.schedules.rows.filter((row) =>
      row.source_ref_ids.some((ref) => [legacyPath, monoPath].includes(context.sourcePathById.get(ref)?.path ?? "")),
    )

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.status === "covered")).toBe(true)
    expect(c2.schedules.links.some((link) =>
      link.relation_kind === "matches" && rows.some((row) => link.from_row_id === row.row_id || link.to_row_id === row.row_id),
    )).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("interface and transport parser artifacts are excluded without hiding new or ambiguous integrations", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-integration-artifact-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-integration-artifact-mono-")
  try {
    const legacyInterfacePath = "src/AppBundle/Mailer/MailerInterface.php"
    const monoInterfacePath = "apps/server/src/App/Support/Infrastructure/Mailer/MailerInterface.php"
    put(legacyRoot, legacyInterfacePath, "<?php\nnamespace AppBundle\\Mailer;\ninterface MailerInterface { public function send(Message $message); }\n")
    put(monoRoot, monoInterfacePath, "<?php\nnamespace App\\Support\\Infrastructure\\Mailer;\ninterface MailerInterface { public function send(Message $message); }\n")
    put(monoRoot, "packages/sdk/src/transport.ts", `export interface Transport { put(url: string): void }
function parseViolations(): void {}
function executeFetch(): void { fetch("https://api.example.test/transport") }
export function createTransport(): Transport { return { put() {} } }
`)

    const newIntegrationPath = "apps/server/src/App/Webhook/Infrastructure/WebhookClient.php"
    const newIntegrationClass = "App\\Webhook\\Infrastructure\\WebhookClient"
    put(monoRoot, newIntegrationPath, `<?php
namespace App\\Webhook\\Infrastructure;
final class WebhookClient
{
    public function send(): void
    {
        fetch("https://api.example.test/new");
    }
}
`)
    put(monoRoot, "apps/server/config/services.yaml", serviceConfig([newIntegrationClass]))
    const ambiguousLegacy = [
      ["src/AppBundle/EventSubscriber/Admissions/NoticeSubscriber.php", "AppBundle\\EventSubscriber\\Admissions\\NoticeSubscriber"],
      ["src/AppBundle/EventSubscriber/Support/NoticeSubscriber.php", "AppBundle\\EventSubscriber\\Support\\NoticeSubscriber"],
    ] as const
    for (const [path, className] of ambiguousLegacy) {
      const namespace = className.slice(0, className.lastIndexOf("\\"))
      put(legacyRoot, path, subscriberSource(namespace, "NoticeSubscriber"))
    }
    const modernAmbiguousClass = "App\\Notice\\Infrastructure\\Subscriber\\NoticeSubscriber"
    put(monoRoot, "apps/server/src/App/Notice/Infrastructure/Subscriber/NoticeSubscriber.php", subscriberSource("App\\Notice\\Infrastructure\\Subscriber", "NoticeSubscriber"))
    put(legacyRoot, "app/config/services.yml", serviceConfig(ambiguousLegacy.map(([, className]) => className)))
    put(monoRoot, "apps/server/config/services.yaml", serviceConfig([newIntegrationClass, modernAmbiguousClass]))

    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("integration-artifact-shape"))
    const pathFor = (row: { readonly source_ref_ids: readonly string[] }): string | null =>
      row.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path ?? null).find((path): path is string => path !== null) ?? null
    const rows = c2.integrations.rows
    expect(rows.some((row) => pathFor(row) === legacyInterfacePath || pathFor(row) === monoInterfacePath)).toBe(false)
    expect(rows.some((row) => pathFor(row) === "packages/sdk/src/transport.ts")).toBe(false)
    expect(rows.find((row) => pathFor(row) === newIntegrationPath)?.status).toBe("extra")

    const ambiguous = rows.filter((row) => pathFor(row)?.includes("NoticeSubscriber.php"))
    expect(ambiguous.filter((row) => row.authority_line === "legacy").every((row) => row.status === "missing")).toBe(true)
    expect(ambiguous.filter((row) => row.authority_line === "mono").every((row) => row.status === "extra")).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
