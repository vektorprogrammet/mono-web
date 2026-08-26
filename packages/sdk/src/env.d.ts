// `import.meta.env` is injected by Vite in browser bundles; plain tsc/Node has no such type.
interface ImportMeta {
  readonly env?: Record<string, string | undefined>;
}
