import type { Config } from "@react-router/dev/config";

/**
 * `allowedActionOrigins` feeds React Router's server-side CSRF origin check
 * for form actions. The apex preview terminates TLS at Cloudflare and the
 * edge worker forwards the browser's Origin to this app, which is served on
 * a local port, so the apex origin must be explicitly trusted. The origin is
 * taken from PREVIEW_HOST so other deployments keep the default (empty) list.
 */
const previewHost = process.env.PREVIEW_HOST;

export default {
  appDirectory: "app",
  ssr: true,
  ...(previewHost ? { allowedActionOrigins: [`https://${previewHost}`] } : {}),
} satisfies Config;
