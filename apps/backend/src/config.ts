import { ContactEmail } from "@vektorprogrammet/domain/contact";
import { mailDeliveryConfig, type MailDeliveryConfig } from "./mail/http.js";
import { receiptDeliveryConfig, type ReceiptDeliveryConfig } from "./receipt/delivery.js";
import {
  recruitmentNotificationConfig,
  type RecruitmentNotificationConfig,
} from "./recruitment/delivery.js";
import {
  schoolServiceNotificationConfig,
  type SchoolServiceNotificationConfig,
} from "./placements/notification.js";
import {
  schoolServiceDispatchNotificationConfig,
  type SchoolServiceDispatchNotificationConfig,
} from "./placements/dispatch-notification.js";
import { onboardingDeliveryConfig, type OnboardingDeliveryConfig } from "./onboarding/delivery.js";
import {
  OAUTH_NATIVE_API_RESOURCE,
  type OAuthProviderRuntimeConfig,
} from "@vektorprogrammet/database";
import { decodeAdmissionApiConfig, type AdmissionApiConfig } from "./admission/config.js";
import { decodeOrganizationApiConfig, type OrganizationApiConfig } from "./organization/config.js";
import { decodeReceiptApiConfig, type ReceiptApiConfig } from "./receipt/config.js";
import { recruitmentApiConfig, type RecruitmentApiConfig } from "./recruitment/config.js";
import {
  decodeNativeSessionBoundaryPolicy,
  type NativeSessionBoundaryPolicy,
} from "./session-security.js";

import { contactConfig, type ContactConfig } from "./contact/config.js";
import { Config, ConfigProvider, Effect, Redacted, Schema, SchemaGetter } from "effect";

export interface PublicApplicationEffectConfig {
  readonly endpoint: URL;
  readonly token: string;
  readonly pollIntervalMilliseconds: number;
  readonly staleClaimMilliseconds: number;
  readonly deliveryTimeoutMilliseconds: number;
}

export interface PasswordResetDeliveryConfig {
  readonly sender: string;
  readonly transport: MailDeliveryConfig;
  readonly pollIntervalMilliseconds: number;
}

export interface BackendAuthConfig {
  readonly postgresUrl: string;
  readonly secret: string;
  readonly oauth: OAuthProviderRuntimeConfig;
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly secureCookies: boolean;
  readonly internalSourceNetworks: ReadonlyArray<string>;
}

export interface BackendConfig {
  readonly contact?: ContactConfig;
  readonly onboarding?: OnboardingDeliveryConfig;
  readonly passwordResetDelivery?: PasswordResetDeliveryConfig;
  readonly receiptDelivery?: ReceiptDeliveryConfig;
  readonly receiptDeliveryPollMilliseconds?: number;
  readonly host: string;
  readonly port: number;
  readonly postgresUrl: string;
  /** Native identity engine inputs (spec 0054). */
  readonly auth: BackendAuthConfig;
  readonly sessionBoundary: NativeSessionBoundaryPolicy;
  readonly admission: AdmissionApiConfig;
  readonly receipt: ReceiptApiConfig;
  readonly recruitment: RecruitmentApiConfig;
  readonly organization: OrganizationApiConfig;
  readonly recruitmentNotifications?: RecruitmentNotificationConfig;
  readonly publicApplicationEffects?: PublicApplicationEffectConfig;
  readonly schoolServiceNotifications?: SchoolServiceNotificationConfig;
  readonly schoolServiceDispatchNotifications?: SchoolServiceDispatchNotificationConfig;
}

const exactOrigin = (value: string, field: string): string => {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute origin`);
  }

  if (
    url.origin !== value ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === "localhost" ||
    url.hostname.includes("*")
  ) {
    throw new Error(`${field} must be one exact origin without a trailing slash`);
  }

  const local = url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "";

  if (url.protocol !== "https:" && !local) {
    throw new Error(`${field} must use https or fixed-port http://127.0.0.1`);
  }

  return value;
};

const internalSourceNetworks = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> => {
  const values = (env.OAUTH_INTERNAL_SOURCE_NETWORKS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (
    values.some((value) => !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/u.test(value))
  ) {
    throw new Error("OAUTH_INTERNAL_SOURCE_NETWORKS must contain comma-separated IPv4 CIDRs");
  }

  if (env.BACKEND_INGRESS === "internal" && values.length === 0) {
    throw new Error("OAUTH_INTERNAL_SOURCE_NETWORKS is required for internal ingress");
  }

  return values;
};

const oauthSettings = Config.all({
  canonicalOrigin: Config.NonEmptyString("OAUTH_CANONICAL_ORIGIN"),
  dashboardOrigin: Config.NonEmptyString("OAUTH_DASHBOARD_ORIGIN"),
});

const oauthBackendConfig = (
  env: Readonly<Record<string, string | undefined>>,
  trustedOrigins: ReadonlyArray<string>,
  provider: ConfigProvider.ConfigProvider,
): Pick<BackendAuthConfig, "oauth" | "internalSourceNetworks"> => {
  const settings = Effect.runSync(oauthSettings.parse(provider));
  const canonicalOrigin = exactOrigin(settings.canonicalOrigin, "OAUTH_CANONICAL_ORIGIN");
  const dashboardOrigin = exactOrigin(settings.dashboardOrigin, "OAUTH_DASHBOARD_ORIGIN");

  if (!trustedOrigins.includes(dashboardOrigin)) {
    throw new Error("OAUTH_DASHBOARD_ORIGIN must be a trusted first-party origin");
  }

  if (env.OAUTH_NATIVE_API_RESOURCE !== OAUTH_NATIVE_API_RESOURCE) {
    throw new Error(`OAUTH_NATIVE_API_RESOURCE must be ${OAUTH_NATIVE_API_RESOURCE}`);
  }

  return {
    oauth: {
      canonicalOrigin,
      dashboardOrigin,
      nativeApiResource: OAUTH_NATIVE_API_RESOURCE,
    },
    internalSourceNetworks: internalSourceNetworks(env),
  };
};

export const decodeOAuthBackendConfig = (
  env: Readonly<Record<string, string | undefined>>,
  trustedOrigins: ReadonlyArray<string>,
): Pick<BackendAuthConfig, "oauth" | "internalSourceNetworks"> =>
  oauthBackendConfig(
    env,
    trustedOrigins,
    ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true }),
  );

const PositiveInteger = Schema.String.check(Schema.isPattern(/^\d+$/u)).pipe(
  Schema.decodeTo(Schema.Int.check(Schema.isGreaterThan(0)), {
    decode: SchemaGetter.transform(Number),
    encode: SchemaGetter.transform(String),
  }),
);

const listenerSettings = Config.all({
  host: Config.Literals(["127.0.0.1", "localhost", "::1"], "BACKEND_HOST").pipe(
    Config.withDefault("127.0.0.1"),
  ),
  port: Config.schema(
    PositiveInteger.check(Schema.isLessThanOrEqualTo(65_535)),
    "BACKEND_PORT",
  ).pipe(Config.withDefault(8790)),
});

const authSettings = Config.all({
  postgresUrl: Config.schema(Schema.Redacted(Schema.NonEmptyString), "BACKEND_PG_URL"),
  secret: Config.schema(
    Schema.Redacted(Schema.String.check(Schema.isMinLength(32))),
    "BETTER_AUTH_SECRET",
  ),
});

const publicApplicationSettings = Config.all({
  endpoint: Config.URL("PUBLIC_APPLICATION_EFFECT_ENDPOINT"),
  token: Config.schema(Schema.Redacted(Schema.NonEmptyString), "PUBLIC_APPLICATION_EFFECT_TOKEN"),
  pollIntervalMilliseconds: Config.schema(
    PositiveInteger,
    "PUBLIC_APPLICATION_EFFECT_POLL_MS",
  ).pipe(Config.withDefault(250)),
  staleClaimMilliseconds: Config.schema(PositiveInteger, "PUBLIC_APPLICATION_EFFECT_STALE_MS").pipe(
    Config.withDefault(60_000),
  ),
  deliveryTimeoutMilliseconds: Config.schema(
    PositiveInteger,
    "PUBLIC_APPLICATION_EFFECT_TIMEOUT_MS",
  ).pipe(Config.withDefault(10_000)),
});

const providerEndpoint = (endpoint: URL): URL => {
  const loopback =
    endpoint.hostname === "127.0.0.1" ||
    endpoint.hostname === "localhost" ||
    endpoint.hostname === "::1";

  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new Error("PUBLIC_APPLICATION_EFFECT_ENDPOINT must use HTTPS unless it targets loopback");
  }

  if (endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw new Error("PUBLIC_APPLICATION_EFFECT_ENDPOINT must not contain credentials");
  }

  return endpoint;
};

const publicApplicationEffectConfig = (
  env: Readonly<Record<string, string | undefined>>,
  provider: ConfigProvider.ConfigProvider,
): PublicApplicationEffectConfig | undefined => {
  const mode = env.PUBLIC_APPLICATION_EFFECT_MODE;
  const endpoint = env.PUBLIC_APPLICATION_EFFECT_ENDPOINT;
  const token = env.PUBLIC_APPLICATION_EFFECT_TOKEN;

  if (mode === "disabled") {
    if (endpoint !== undefined || token !== undefined) {
      throw new Error(
        "PUBLIC_APPLICATION_EFFECT_ENDPOINT and PUBLIC_APPLICATION_EFFECT_TOKEN require PUBLIC_APPLICATION_EFFECT_MODE=http",
      );
    }

    return undefined;
  }

  if (mode !== "http") {
    throw new Error("PUBLIC_APPLICATION_EFFECT_MODE must be disabled or http");
  }

  const settings = Effect.runSync(publicApplicationSettings.parse(provider));

  return {
    ...settings,
    endpoint: providerEndpoint(settings.endpoint),
    token: Redacted.value(settings.token),
  };
};

export const decodeBackendConfig = (
  env: Readonly<Record<string, string | undefined>>,
): BackendConfig => {
  const provider = ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true });
  const admission = decodeAdmissionApiConfig(env);
  const receipt = decodeReceiptApiConfig(env);
  const sessionBoundary = decodeNativeSessionBoundaryPolicy(env);
  const effects = publicApplicationEffectConfig(env, provider);
  const schoolServiceNotifications = schoolServiceNotificationConfig(env);
  const schoolServiceDispatchNotifications = schoolServiceDispatchNotificationConfig(env);
  const credentials = Effect.runSync(authSettings.parse(provider));
  const postgresUrl = Redacted.value(credentials.postgresUrl);
  const secret = Redacted.value(credentials.secret);
  const oauth = oauthBackendConfig(env, sessionBoundary.trustedOrigins, provider);
  const receiptDelivery = receiptDeliveryConfig(env);
  let passwordResetDelivery: PasswordResetDeliveryConfig | undefined;
  let receiptDeliveryPollMilliseconds: number | undefined;

  if (env.PASSWORD_RESET_DELIVERY_MODE === "http") {
    const transport = mailDeliveryConfig(env);

    if (!transport) throw new Error("Password reset delivery requires mail configuration");
    passwordResetDelivery = {
      transport,
      sender: Redacted.value(
        Effect.runSync(Config.schema(Schema.Redacted(ContactEmail), "MAIL_SENDER").parse(provider)),
      ),
      pollIntervalMilliseconds: Effect.runSync(
        Config.schema(PositiveInteger, "PASSWORD_RESET_DELIVERY_POLL_MS")
          .pipe(Config.withDefault(1000))
          .parse(provider),
      ),
    };
  } else if (env.PASSWORD_RESET_DELIVERY_MODE !== "disabled") {
    throw new Error("PASSWORD_RESET_DELIVERY_MODE must be disabled or http");
  }

  if (env.RECEIPT_DELIVERY_MODE === "http") {
    if (!receiptDelivery || !env.RECEIPT_STAGING_ROOT || !env.RECEIPT_COMMITTED_ROOT)
      throw new Error("Receipt worker requires delivery configuration and explicit storage roots");
    receiptDeliveryPollMilliseconds = Effect.runSync(
      Config.schema(PositiveInteger, "RECEIPT_DELIVERY_POLL_MS")
        .pipe(Config.withDefault(1000))
        .parse(provider),
    );
  } else if (env.RECEIPT_DELIVERY_MODE !== "disabled") {
    throw new Error("RECEIPT_DELIVERY_MODE must be disabled or http");
  }

  const config: BackendConfig = {
    contact: contactConfig(env),
    passwordResetDelivery,
    receiptDelivery,
    receiptDeliveryPollMilliseconds,
    onboarding: onboardingDeliveryConfig(env),
    recruitmentNotifications: recruitmentNotificationConfig(env),
    ...Effect.runSync(listenerSettings.parse(provider)),
    postgresUrl,
    sessionBoundary,
    auth: {
      postgresUrl,
      secret,
      ...oauth,
      trustedOrigins: sessionBoundary.trustedOrigins,
      secureCookies: sessionBoundary.secureCookies,
    },
    admission,
    receipt,
    recruitment: recruitmentApiConfig(admission),
    organization: decodeOrganizationApiConfig(env),
  };

  if (effects !== undefined) Object.assign(config, { publicApplicationEffects: effects });

  if (schoolServiceNotifications !== undefined)
    Object.assign(config, { schoolServiceNotifications });

  if (schoolServiceDispatchNotifications !== undefined)
    Object.assign(config, { schoolServiceDispatchNotifications });

  return config;
};
