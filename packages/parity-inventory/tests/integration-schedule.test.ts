import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { NodeRuntimeLayer } from "../node-runtime.js"
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
  const legacy = await Effect.runPromise(scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)))
  const mono = await Effect.runPromise(scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)))
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
    expect(rows.find((row) => pathFor(row) === newIntegrationPath)?.status).toBe("unresolved")

    const ambiguous = rows.filter((row) => pathFor(row)?.includes("NoticeSubscriber.php"))
    expect(ambiguous.filter((row) => row.authority_line === "legacy").every((row) => row.status === "missing")).toBe(true)
    expect(ambiguous.filter((row) => row.authority_line === "mono").every((row) => row.status === "extra")).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
test("SDK domain calls through local Transport are internal and not integration rows", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-integration-sdk-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-integration-sdk-mono-")
  try {
    put(monoRoot, "packages/sdk/src/transport.ts", `export interface Transport {
  post(path: string, body: unknown): unknown;
  executeFetch(url: string): unknown;
}
function parseViolations(): void {}
function executeFetch(): void { fetch("https://api.example.test/transport"); }
export function createTransport(): Transport {
  return { post() { return undefined; }, executeFetch() { return undefined; } };
}
`)
    put(monoRoot, "packages/sdk/src/domains/auth.ts", `import type { Transport } from "../transport.js";
export function createAuthDomain(transport: Transport) {
  return {
    login(username: string, password: string) {
      return transport.post("/api/login", { username, password });
    },
  };
}
`)

    const context = await contextFor(legacyRoot, monoRoot)
    const integrations = collectC2(context, sha256("integration-sdk-transport")).integrations
    const pathFor = (row: { readonly source_ref_ids: readonly string[] }): string | null =>
      row.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path ?? null).find((path): path is string => path !== null) ?? null

    expect(integrations.rows.some((row) => pathFor(row)?.startsWith("packages/sdk/src/domains/"))).toBe(false)
    expect(integrations.rows.some((row) => pathFor(row) === "packages/sdk/src/transport.ts")).toBe(false)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("manual command schedules reconcile by stable Symfony names after namespace relocation", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-schedule-command-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-schedule-command-mono-")
  try {
    const legacyPath = "src/AppBundle/Command/SendAdmissionNotificationsCommand.php"
    const monoPath = "apps/server/src/App/Admission/Infrastructure/Command/SendAdmissionNotificationsCommand.php"
    const legacyClass = "AppBundle\\Command\\SendAdmissionNotificationsCommand"
    const monoClass = "App\\Admission\\Infrastructure\\Command\\SendAdmissionNotificationsCommand"
    const source = (namespace: string): string => `<?php
namespace ${namespace};
final class SendAdmissionNotificationsCommand
{
    protected function configure(): void
    {
        $this->setName('app:admission:send_notifications');
    }

    protected function execute(): void
    {
    }
}
`
    put(legacyRoot, legacyPath, source("AppBundle\\Command"))
    put(monoRoot, monoPath, source("App\\Admission\\Infrastructure\\Command"))
    put(legacyRoot, "app/config/services.yml", serviceConfig([legacyClass]))
    put(monoRoot, "apps/server/config/services.yaml", serviceConfig([monoClass]))

    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("schedule-command-relocation"))
    const pathFor = (row: { readonly source_ref_ids: readonly string[] }): string | null =>
      row.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path ?? null).find((path): path is string => path !== null) ?? null
    const rows = c2.schedules.rows.filter((row) => pathFor(row) === legacyPath || pathFor(row) === monoPath)

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.status === "covered")).toBe(true)
    expect(rows.every((row) => "trigger_identity" in row.details && row.details.trigger_identity === "app:admission:send_notifications")).toBe(true)
    const rowIds = new Set(rows.map((row) => row.row_id))
    expect(c2.schedules.links.some((link) =>
      link.relation_kind === "matches" && rowIds.has(link.from_row_id) && rowIds.has(link.to_row_id),
    )).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("event subscriber service roots reconcile without inheriting unrelated disabled parameters", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-schedule-event-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-schedule-event-mono-")
  try {
    const legacyPath = "app/config/event_subscribers.yml"
    const monoPath = "apps/server/config/services.yaml"
    put(legacyRoot, "app/config/config.yml", "imports:\n  - { resource: event_subscribers.yml }\n")
    put(legacyRoot, legacyPath, `services:
  AppBundle\\EventSubscriber\\:
    resource: "../../src/AppBundle/EventSubscriber"
`)
    put(monoRoot, monoPath, `parameters:
  google_api:
    disabled: true
services:
  App\\Support\\EventSubscriber\\:
    resource: "../src/App/Support/EventSubscriber"
    tags:
      - { name: kernel.event_subscriber }
`)

    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("schedule-event-root-relocation"))
    const pathFor = (row: { readonly source_ref_ids: readonly string[] }): string | null =>
      row.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path ?? null).find((path): path is string => path !== null) ?? null
    const rows = c2.schedules.rows.filter((row) => pathFor(row) === legacyPath || pathFor(row) === monoPath)

    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.status === "covered")).toBe(true)
    expect(rows.every((row) => "trigger_kind" in row.details && row.details.trigger_kind === "event")).toBe(true)
    expect(rows.every((row) => "enabled" in row.details && row.details.enabled === true)).toBe(true)
    expect(c2.schedules.links.some((link) =>
      link.relation_kind === "matches" && rows.some((row) => link.from_row_id === row.row_id || link.to_row_id === row.row_id),
    )).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("Slack transport aliases and Mailer branches do not create wrapper or elseif integrations", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-integration-alias-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-integration-alias-mono-")
  try {
    put(legacyRoot, "src/AppBundle/Service/SlackMessenger.php", `<?php
namespace AppBundle\\Service;
class SlackMessenger
{
    public function send(): void
    {
        $this->slackClient->sendMessage($message);
    }
    public function notify(): void { $this->send(); }
    public function log(): void { $this->send(); }
    public function messageDepartment(): void { $this->send(); }
}
`)
    put(monoRoot, "apps/server/src/App/Support/Infrastructure/Slack/SlackMessenger.php", `<?php
namespace App\\Support\\Infrastructure\\Slack;
class SlackMessenger
{
    public function sendPayload(): void
    {
        $this->httpClient->post("https://api.example.test/slack");
    }
    public function notify(): void { $this->sendPayload(); }
    public function log(): void { $this->sendPayload(); }
    public function messageDepartment(): void { $this->sendPayload(); }
}
`)
    put(legacyRoot, "src/AppBundle/Service/SlackMailer.php", `<?php
namespace AppBundle\\Service;
class SlackMailer
{
    public function send(): void
    {
        $this->messenger->send($message);
    }
}
`)
    put(monoRoot, "apps/server/src/App/Support/Infrastructure/Slack/SlackMailer.php", `<?php
namespace App\\Support\\Infrastructure\\Slack;
class SlackMailer
{
    public function send(): void
    {
        $this->messenger->sendPayload($message);
    }
}
`)
    const mailerSource = (namespace: string): string => `<?php
namespace ${namespace};
class Mailer
{
    public function send(): void
    {
        if ($this->env === 'prod') {
            $this->gmail->send($message);
        } elseif ($this->env === 'staging') {
            $this->slackMailer->send($message);
        } else {
            $this->mailer->send($message);
        }
    }
}
`
    put(legacyRoot, "src/AppBundle/Mailer/Mailer.php", mailerSource("AppBundle\\Mailer"))
    put(monoRoot, "apps/server/src/App/Support/Infrastructure/Mailer/Mailer.php", mailerSource("App\\Support\\Infrastructure\\Mailer"))
    put(legacyRoot, "app/config/services.yml", serviceConfig([
      "AppBundle\\Service\\SlackMessenger",
      "AppBundle\\Service\\SlackMailer",
      "AppBundle\\Mailer\\Mailer",
    ]))
    put(monoRoot, "apps/server/config/services.yaml", serviceConfig([
      "App\\Support\\Infrastructure\\Slack\\SlackMessenger",
      "App\\Support\\Infrastructure\\Slack\\SlackMailer",
      "App\\Support\\Infrastructure\\Mailer\\Mailer",
    ]))

    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("integration-aliases"))
    const pathFor = (row: { readonly source_ref_ids: readonly string[] }): string | null =>
      row.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path ?? null).find((path): path is string => path !== null) ?? null
    const rows = c2.integrations.rows.filter((row) =>
      pathFor(row)?.endsWith("SlackMessenger.php")
      || pathFor(row)?.endsWith("SlackMailer.php")
      || pathFor(row)?.endsWith("Mailer.php"),
    )
    const byOwner = (owner: string, authority: "legacy" | "mono") => rows.filter((row) => {
      if (row.authority_line !== authority || !("call_site_ref" in row.details)) return false
      const callSiteRef = row.details.call_site_ref
      return callSiteRef === owner || callSiteRef?.endsWith(`\\${owner}`) === true
    })

    expect(byOwner("SlackMessenger::send", "legacy")).toHaveLength(1)
    expect(byOwner("SlackMessenger::sendPayload", "mono")).toHaveLength(1)
    expect(byOwner("SlackMailer::send", "legacy")).toHaveLength(1)
    expect(byOwner("SlackMailer::send", "mono")).toHaveLength(1)
    expect(byOwner("Mailer::send", "legacy")).toHaveLength(1)
    expect(byOwner("Mailer::send", "mono")).toHaveLength(1)
    expect(rows.some((row) => "call_site_ref" in row.details && row.details.call_site_ref?.endsWith("Mailer::elseif"))).toBe(false)
    expect(rows.filter((row) => "call_site_ref" in row.details && row.details.call_site_ref?.includes("SlackMessenger::")).every((row) => row.status === "covered")).toBe(true)
    expect(rows.filter((row) => "call_site_ref" in row.details && row.details.call_site_ref?.includes("SlackMailer::")).every((row) => row.status === "covered")).toBe(true)
    expect(rows.filter((row) => "call_site_ref" in row.details && row.details.call_site_ref?.includes("Mailer::")).every((row) => row.status === "covered")).toBe(true)
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})

test("preview workers are reachable through explicit Wrangler and Alchemy entrypoint edges", async () => {
  const legacyRoot = mkdtempSync("/tmp/parity-preview-entrypoint-legacy-")
  const monoRoot = mkdtempSync("/tmp/parity-preview-entrypoint-mono-")
  try {
    put(monoRoot, "package.json", JSON.stringify({
      scripts: {
        "preview:dev": "WRANGLER_SEND_METRICS=false node node_modules/wrangler/bin/wrangler.js dev infra/preview.worker.ts --local",
      },
    }))
    put(monoRoot, "infra/preview.worker.ts", `export default {
  fetch(request: Request): Response {
    return new Response(request.url);
  },
};
`)
    put(monoRoot, "infra/alchemy/alchemy.run.ts", `import { PreviewWorker } from "./preview/worker-resource.ts";
export default Alchemy.Stack("vektor", {}, () => PreviewWorker);
`)
    put(monoRoot, "infra/alchemy/preview/worker-resource.ts", `export class PreviewWorker {
  main = new URL("./worker.ts", import.meta.url).pathname;
}
`)
    put(monoRoot, "infra/alchemy/preview/worker.ts", `import { Container, getContainer } from "@cloudflare/containers";
export class PreviewContainer extends Container {}
export default {
  fetch(request: Request, env: { PreviewContainer: Parameters<typeof getContainer<PreviewContainer>>[0] }): Response {
    return getContainer(env.PreviewContainer, "vektor-preview").fetch(request);
  },
};
`)

    const context = await contextFor(legacyRoot, monoRoot)
    const c2 = collectC2(context, sha256("preview-entrypoint-edges"))
    const pathFor = (row: { readonly source_ref_ids: readonly string[] }): string | null =>
      row.source_ref_ids.map((ref) => context.sourcePathById.get(ref)?.path ?? null).find((path): path is string => path !== null) ?? null
    const previewRows = c2.integrations.rows.filter((row) =>
      pathFor(row) === "infra/preview.worker.ts"
      || pathFor(row) === "infra/alchemy/preview/worker.ts",
    )

    expect(previewRows.some((row) => pathFor(row) === "infra/preview.worker.ts")).toBe(false)
    const containerRow = previewRows.find((row) => pathFor(row) === "infra/alchemy/preview/worker.ts")
    expect(containerRow).toMatchObject({
      status: "extra",
      details: {
        provider_ref: "cloudflare-containers",
        direction: "outbound",
        protocol: "http",
        effect_classes: ["outbound"],
      },
    })
    expect(containerRow?.details.call_site_ref).toBe("PreviewContainer::fetch")
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true })
    rmSync(monoRoot, { recursive: true, force: true })
  }
})
