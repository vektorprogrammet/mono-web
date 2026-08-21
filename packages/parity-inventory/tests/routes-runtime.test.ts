import { canonicalRouteKey, sha256 } from "../src/canonical.js"
import { decodeRuntimeRoutePayload, reconcileRuntimeRouteRows, type RuntimeRoute } from "../src/routes.js"
import type { InventoryRow, MonoRouteDetails, RuntimeObservation } from "../src/types.js"

const digest = sha256("route-runtime-test")

const runtimeObservation = (availability: RuntimeObservation["availability"]): RuntimeObservation => ({
  runtime_observation_ref_id: `runtime-${availability}`,
  revision_ref_id: "rev-mono",
  collector_kind: "route_collector",
  logical_command_id: "debug:router",
  command: "php bin/console debug:router --format=json --env=test --no-debug",
  argument_digest: digest,
  executable_digests: { php: digest, bwrap: digest },
  executable_provenance: { php: "usr-bin", bwrap: "usr-bin" },
  stdout_sha256: digest,
  stderr_sha256: digest,
  exit_code: availability === "available" ? 0 : 127,
  result_sha256: digest,
  availability,
})

const staticRouteRow = (status: InventoryRow["status"] = "covered", method: string | null = "GET", path = "/fixture", name = "fixture"): InventoryRow => {
  const canonicalKey = canonicalRouteKey(method, path, name)
  const details: MonoRouteDetails = {
    declaration_kind: "controller_attribute",
    route_origin: "controller",
    route_name: name,
    path_template: path,
    method,
    owner_ref: "App\\Fixture\\Controller",
    runtime_resolved: false,
    imported_from_ref: null,
  }
  return {
    row_id: `row-static-${name}`,
    declaration_id: `decl-static-${name}`,
    inventory_kind: "mono_route",
    authority_line: "mono",
    canonical_key: canonicalKey,
    signature: canonicalKey,
    status,
    observation_kinds: ["static_source"],
    source_ref_ids: ["source-static"],
    revision_ref_ids: ["rev-mono"],
    runtime_observation_ref_ids: [],
    coverage_ref_ids: [],
    accepted_intent_ref_ids: [],
    duplicate_group_id: null,
    reason_codes: status === "dead_unimported" ? ["DEAD_UNIMPORTED_SOURCE"] : [],
    related_row_ids: [],
    mismatch: { kind: "none", disposition: "none", accepted_intent_ref_ids: [], counterpart_row_ids: [], reason: null },
    details,
  }
}

describe("authoritative Symfony route runtime falsifiers", () => {
  test("success normalizes paths, splits concrete pipe methods, and resolves ANY", () => {
    const payload = {
      fixture: { path: " fixture ", method: "POST|GET", defaults: { _controller: "App\\Fixture\\Controller" } },
      wildcard: { path: "/wildcard", method: "ANY" },
      placeholder_default: { path: "/placeholder", method: "GET", defaults: { token: null } },
    }
    expect(decodeRuntimeRoutePayload(payload)).toEqual([
      { routeName: "fixture", pathTemplate: "/fixture", methods: ["GET", "POST"] },
      { routeName: "placeholder_default", pathTemplate: "/placeholder", methods: ["GET"] },
      { routeName: "wildcard", pathTemplate: "/wildcard", methods: [] },
    ])
  })

  test("malformed and unsafe output fails closed", () => {
    expect(decodeRuntimeRoutePayload([])).toBeNull()
    expect(decodeRuntimeRoutePayload({ fixture: { path: "/fixture", method: "GET|" } })).toBeNull()
    expect(decodeRuntimeRoutePayload({ fixture: { path: "/fixture", method: "GET", defaults: { token: "not-a-placeholder" } } })).toBeNull()
  })

  test("unavailable collector leaves static rows unresolved", () => {
    const result = reconcileRuntimeRouteRows("rev-mono", [staticRouteRow()], [], runtimeObservation("unavailable"), "source-runtime", [{ source_ref_id: "source-runtime", reason_code: "RUNTIME_UNAVAILABLE", status: "unresolved" }])
    expect(result.rows.find((row) => row.row_id === "row-static-fixture")).toMatchObject({ status: "unresolved", reason_codes: expect.arrayContaining(["RUNTIME_UNAVAILABLE"]) })
  })

  test("matching runtime observations merge into the static authority row", () => {
    const result = reconcileRuntimeRouteRows(
      "rev-mono",
      [staticRouteRow()],
      [{ routeName: "fixture", pathTemplate: "/fixture", methods: ["GET"] }],
      runtimeObservation("available"),
      "source-runtime",
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      status: "covered",
      observation_kinds: ["static_source", "runtime_resolution"],
      source_ref_ids: ["source-runtime", "source-static"],
      related_row_ids: [],
      details: { runtime_resolved: true },
    })
    expect(result.links).toEqual([])
  })
  test("API Platform route paths reconcile the configured prefix without weakening controller mismatches", () => {
    const apiStatic = staticRouteRow("covered", "GET", "/things", "_api_/things_get")
    const apiDetails = apiStatic.details as MonoRouteDetails
    const result = reconcileRuntimeRouteRows(
      "rev-mono",
      [{ ...apiStatic, details: { ...apiDetails, declaration_kind: "api_platform", route_origin: "api_platform" } }],
      [{ routeName: "_api_/things_get", pathTemplate: "/api/things", methods: ["GET"] }],
      runtimeObservation("available"),
      "source-runtime",
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ status: "covered", observation_kinds: ["static_source", "runtime_resolution"] })

    const controller = reconcileRuntimeRouteRows(
      "rev-mono",
      [staticRouteRow("covered", "GET", "/things", "_api_/things_get")],
      [{ routeName: "_api_/things_get", pathTemplate: "/api/things", methods: ["GET"] }],
      runtimeObservation("available"),
      "source-runtime",
    )
    expect(controller.rows).toHaveLength(2)
    expect(controller.rows.every((row) => row.status === "changed")).toBe(true)
  })

  test("unconstrained runtime methods normalize to ANY", () => {
    const staticRow = staticRouteRow()
    const result = reconcileRuntimeRouteRows(
      "rev-mono",
      [{ ...staticRow, details: { ...staticRow.details, method: "ANY" } }],
      [{ routeName: "fixture", pathTemplate: "/fixture", methods: [] }],
      runtimeObservation("available"),
      "source-runtime",
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      status: "covered",
      observation_kinds: ["static_source", "runtime_resolution"],
      details: { method: "ANY", runtime_resolved: true },
    })
  })

  test("static/runtime disagreement retains both observations", () => {
    const runtimeRoute: RuntimeRoute = { routeName: "fixture", pathTemplate: "/changed", methods: ["POST"] }
    const result = reconcileRuntimeRouteRows("rev-mono", [staticRouteRow()], [runtimeRoute], runtimeObservation("available"), "source-runtime")
    const staticRow = result.rows.find((row) => row.row_id === "row-static-fixture")
    const runtimeRow = result.rows.find((row) => row.observation_kinds.includes("runtime_resolution"))
    expect(staticRow).toMatchObject({ status: "changed", observation_kinds: ["static_source", "runtime_resolution"], reason_codes: expect.arrayContaining(["STATIC_RUNTIME_MISMATCH"]) })
    expect(runtimeRow).toMatchObject({ status: "changed", reason_codes: ["STATIC_RUNTIME_MISMATCH"] })
  })

  test("runtime-only source remains extra", () => {
    const result = reconcileRuntimeRouteRows("rev-mono", [], [{ routeName: "runtime_only", pathTemplate: "/runtime-only", methods: ["GET"] }], runtimeObservation("available"), "source-runtime")
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ status: "extra", reason_codes: ["RUNTIME_ONLY_SOURCE"] })
  })

  test("dead or unimported static source remains dead when runtime completes without it", () => {
    const result = reconcileRuntimeRouteRows("rev-mono", [staticRouteRow("dead_unimported")], [], runtimeObservation("available"), "source-runtime")
    expect(result.rows.find((row) => row.row_id === "row-static-fixture")).toMatchObject({ status: "dead_unimported", reason_codes: expect.arrayContaining(["DEAD_UNIMPORTED_SOURCE"]) })
  })
})
