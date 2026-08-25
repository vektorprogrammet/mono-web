import type { Config } from "@react-router/dev/config";

/**
 * `allowedActionOrigins` feeds React Router's server-side CSRF origin check
 * for form actions. The apex preview terminates TLS at Cloudflare and the
 * edge worker forwards the browser's Origin (https://vektor.phibkro.org)
 * to this app, which is served on http://127.0.0.1:<port> locally, so the
 * apex origin must be explicitly trusted.
 */
export default {
  appDirectory: "app",
  ssr: true,
  allowedActionOrigins: ["https://vektor.phibkro.org"],
} satisfies Config;
