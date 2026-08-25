import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NodeRuntimeLayer } from "../node-runtime.js"
import { canonicalApiPlatformPath, canonicalApiPlatformRouteName, collectApiOperations } from "../src/api.js"
import { collectRoutes } from "../src/routes.js"
import { canonicalRouteKey, sha256 } from "../src/canonical.js"
import { scanRootEffect } from "../src/runtime.js"
import { createManifestContextFromSnapshots } from "../src/source-manifest.js"
import type { InventoryRow, MonoRouteDetails } from "../src/types.js"

const runtimeRoute = (
  rowId: string,
  routeName: string,
  pathTemplate: string,
  method: string,
): InventoryRow => {
  const details: MonoRouteDetails = {
    declaration_kind: "unknown",
    route_origin: "imported",
    route_name: routeName,
    path_template: pathTemplate,
    method,
    owner_ref: null,
    runtime_resolved: true,
    imported_from_ref: null,
  }
  const canonicalKey = canonicalRouteKey(method, pathTemplate, routeName)
  return {
    row_id: rowId,
    declaration_id: `decl-${rowId}`,
    inventory_kind: "mono_route",
    authority_line: "mono",
    canonical_key: canonicalKey,
    signature: canonicalKey,
    status: "extra",
    observation_kinds: ["runtime_resolution"],
    source_ref_ids: ["source-runtime-route"],
    revision_ref_ids: ["rev-mono"],
    runtime_observation_ref_ids: [],
    coverage_ref_ids: [],
    accepted_intent_ref_ids: [],
    duplicate_group_id: null,
    reason_codes: ["RUNTIME_ONLY_SOURCE"],
    related_row_ids: [],
    mismatch: {
      kind: "extra",
      disposition: "none",
      accepted_intent_ref_ids: [],
      counterpart_row_ids: [],
      reason: "RUNTIME_ONLY_SOURCE",
    },
    details,
  }
}

test("API Platform prefix reconciliation covers declared routes and retains generated extras", async () => {
  const directory = mkdtempSync("/tmp/parity-api-prefix-")
  const legacyRoot = join(directory, "legacy")
  const monoRoot = join(directory, "mono")
  const resourcePath = "apps/server/src/App/Fixture/Api/Resource/Thing.php"
  mkdirSync(legacyRoot)
  mkdirSync(join(monoRoot, "apps/server/config"), { recursive: true })
  mkdirSync(join(monoRoot, "apps/server/src/App/Fixture/Api/Resource"), { recursive: true })
  writeFileSync(join(monoRoot, "apps/server/config/routes.yaml"), "api_platform:\n  resource: .\n  type: api_platform\n  prefix: /api\n")
  writeFileSync(
    join(monoRoot, resourcePath),
    "<?php\nnamespace App\\Fixture\\Api\\Resource;\nuse ApiPlatform\\Metadata\\ApiResource;\nuse ApiPlatform\\Metadata\\Get;\n#[ApiResource(operations: [new Get(uriTemplate: '/things')])]\nfinal class Thing {}\n",
  )
  try {
    const legacy = await Effect.runPromise(scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)))
    const mono = await Effect.runPromise(scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)))
    const context = createManifestContextFromSnapshots(legacy, mono)
    const routeCollection = await Effect.runPromise(collectRoutes(context, sha256("api-prefix-routes"), undefined, true).pipe(Effect.provide(NodeRuntimeLayer)))
    const routeRows = routeCollection.mono.rows as InventoryRow[]
    routeRows.push(
      runtimeRoute("row-declared-route", "_api_/things_get", "/api/things", "GET"),
      runtimeRoute("row-declared-head", "_api_/things_get", "/api/things", "HEAD"),
      runtimeRoute("row-generated-route", "_api_/things/{id}{._format}_get", "/api/things/{id}.{_format}", "GET"),
    )
    const result = await Effect.runPromise(collectApiOperations(context,
    sha256("api-prefix-test"),
    routeRows,
    true,
    undefined,
    {
      path: "fixture-api-prefix",
      bytes: new TextEncoder().encode(
        JSON.stringify([
          {
            resource_class_ref: "App\\Fixture\\Api\\Resource\\Thing",
            resource_key: "Thing",
            operation_name: "Get",
            method: "GET",
            uri_template: "/api/things",
            operation_id: "_api_/things_get",
          },
          {
            resource_class_ref: "App\\Fixture\\Api\\Resource\\Thing",
            resource_key: "Thing",
            operation_name: "NotExposed",
            method: "GET",
            uri_template: "/api/things/{id}{._format}",
            operation_id: "_api_/things/{id}{._format}_get",
          },
        ]),
      ),
    },).pipe(Effect.provide(NodeRuntimeLayer)))
    const declared = result.h3RouteRows.find((row) => row.row_id === "row-declared-route")
    const generated = result.h3RouteRows.find((row) => row.row_id === "row-generated-route")
    expect(declared).toBeUndefined()
    expect(result.h3RouteRows.find((row) => row.row_id === "row-declared-head")).toBeUndefined()
    expect(routeRows.some((row) => row.row_id === "row-declared-head")).toBe(false)
    expect(generated).toMatchObject({ status: "extra", reason_codes: ["RUNTIME_ONLY_SOURCE"] })
    const operationRows = result.rows.filter((row) => row.observation_kinds.includes("static_source"))
    expect(routeCollection.mono.rows.some((row) => row.row_id === "row-declared-route")).toBe(false)
    const declaredOperation = operationRows.find((row) => "operation_name" in row.details && row.details.operation_name === "Get")
    expect(declaredOperation).toMatchObject({ status: "covered" })
    expect(declaredOperation?.source_ref_ids).toContain("source-runtime-route")
    expect(operationRows.some((row) => row.status === "covered" && "operation_name" in row.details)).toBe(true)
    expect(result.rows.some((row) => row.status === "extra" && "operation_name" in row.details && row.details.operation_name === "NotExposed")).toBe(true)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
test("omitted StaticContent Get pairs with the default item operation and route evidence", async () => {
  const directory = mkdtempSync("/tmp/parity-api-static-content-")
  const legacyRoot = join(directory, "legacy")
  const monoRoot = join(directory, "mono")
  const resourcePath = "apps/server/src/App/Content/Infrastructure/Entity/StaticContent.php"
  const providerPath = "apps/server/src/App/Content/Api/State/StaticContentByHtmlIdProvider.php"
  mkdirSync(legacyRoot)
  mkdirSync(join(monoRoot, "apps/server/config"), { recursive: true })
  mkdirSync(join(monoRoot, "apps/server/src/App/Content/Infrastructure/Entity"), { recursive: true })
  mkdirSync(join(monoRoot, "apps/server/src/App/Content/Api/State"), { recursive: true })
  writeFileSync(join(monoRoot, "apps/server/config/routes.yaml"), "api_platform:\n  resource: .\n  type: api_platform\n  prefix: /api\n")
  writeFileSync(
    join(monoRoot, resourcePath),
    "<?php\nnamespace App\\Content\\Infrastructure\\Entity;\nuse ApiPlatform\\Metadata\\ApiResource;\nuse ApiPlatform\\Metadata\\Get;\nuse ApiPlatform\\Metadata\\GetCollection;\nuse App\\Content\\Api\\State\\StaticContentByHtmlIdProvider;\n#[ApiResource(operations: [new GetCollection(), new Get(), new Get(uriTemplate: '/static-content/by-html-id/{htmlId}', provider: StaticContentByHtmlIdProvider::class)])]\nfinal class StaticContent {}\n",
  )
  writeFileSync(
    join(monoRoot, providerPath),
    "<?php\nnamespace App\\Content\\Api\\State;\nfinal class StaticContentByHtmlIdProvider {}\n",
  )
  try {
    const legacy = await Effect.runPromise(scanRootEffect(legacyRoot, "legacy").pipe(Effect.provide(NodeRuntimeLayer)))
    const mono = await Effect.runPromise(scanRootEffect(monoRoot, "mono").pipe(Effect.provide(NodeRuntimeLayer)))
    const context = createManifestContextFromSnapshots(legacy, mono)
    const routeRows = [
      runtimeRoute("row-static-content-default-route", "_api_/static_contents/{id}{._format}_get", "/api/static_contents/{id}.{_format}", "GET"),
      runtimeRoute("row-static-content-custom-route", "_api_/static-content/by-html-id/{htmlId}_get", "/api/static-content/by-html-id/{htmlId}", "GET"),
    ]
    const result = await Effect.runPromise(collectApiOperations(context,
    sha256("static-content-default-get"),
    routeRows,
    true,
    undefined,
    {
      path: "fixture-static-content",
      bytes: new TextEncoder().encode(
        JSON.stringify([
          {
            resource_class_ref: "App\\Content\\Infrastructure\\Entity\\StaticContent",
            resource_key: "StaticContent",
            operation_name: "Get",
            method: "GET",
            uri_template: "/static-content/by-html-id/{htmlId}",
            operation_id: "_api_/static-content/by-html-id/{htmlId}_get",
            provider_ref: "App\\Content\\Api\\State\\StaticContentByHtmlIdProvider",
            processor_ref: "ApiPlatform\\Doctrine\\Orm\\State\\PersistProcessor",
          },
          {
            resource_class_ref: "App\\Content\\Infrastructure\\Entity\\StaticContent",
            resource_key: "StaticContent",
            operation_name: "Get",
            method: "GET",
            uri_template: "/api/static_contents/{id}{._format}",
            operation_id: "_api_/static_contents/{id}{._format}_get",
            provider_ref: "ApiPlatform\\Doctrine\\Orm\\State\\ItemProvider",
            processor_ref: "ApiPlatform\\Doctrine\\Orm\\State\\PersistProcessor",
          },
          {
            resource_class_ref: "App\\Content\\Infrastructure\\Entity\\StaticContent",
            resource_key: "StaticContent",
            operation_name: "GetCollection",
            method: "GET",
            uri_template: "/api/static_contents{._format}",
            operation_id: "_api_/static_contents{._format}_get_collection",
            provider_ref: "ApiPlatform\\Doctrine\\Orm\\State\\CollectionProvider",
            processor_ref: "ApiPlatform\\Doctrine\\Orm\\State\\PersistProcessor",
          },
        ]),
      ),
    },).pipe(Effect.provide(NodeRuntimeLayer)))
    const staticRows = result.rows.filter(
      (row) =>
        row.observation_kinds.includes("static_source") &&
        "resource_class_ref" in row.details &&
        row.details.resource_class_ref === "App\\Content\\Infrastructure\\Entity\\StaticContent",
    )
    const defaultGet = staticRows.find(
      (row) => "operation_name" in row.details && row.details.operation_name === "Get" && row.details.uri_template === null,
    )
    expect(defaultGet).toMatchObject({
      status: "covered",
      observation_kinds: ["static_source", "runtime_resolution"],
      reason_codes: [],
    })
    expect(defaultGet?.source_ref_ids).toContain("source-runtime-route")
    expect(routeRows).toHaveLength(0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("API Platform generated route aliases normalize format, prefix, and HEAD derivation", () => {
  expect(canonicalApiPlatformPath("/api/things.{_format}", "/api")).toBe("/things{._format}")
  expect(canonicalApiPlatformPath("/things{._format}", "/api")).toBe("/things{._format}")
  expect(canonicalApiPlatformRouteName("_api_/api/things.{_format}_head", "/api")).toBe(
    canonicalApiPlatformRouteName("_api_/things{._format}_get", "/api"),
  )
  expect(canonicalApiPlatformRouteName("api_login", "/api")).toBe("api_login")
})
