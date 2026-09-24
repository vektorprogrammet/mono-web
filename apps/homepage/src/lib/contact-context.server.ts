import { ContactVisitorIp as ContactVisitorIpSchema } from "@vektorprogrammet/http-api";
import { Schema } from "effect";
import { createContext } from "react-router";
import type { ContactMessageHeaders } from "./api-types";

const canonicalIpv4 = (raw: string): string | undefined => {
  const octets = raw.split(".");

  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet))) {
    return undefined;
  }

  const values = octets.map(Number);

  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return undefined;
  }

  return values.join(".");
};

const canonicalContactIp = (raw: string): string => {
  if (!raw || /[\s,/%[\]]/u.test(raw)) throw new Error("Invalid visitor address");
  const ipv4 = canonicalIpv4(raw);

  if (ipv4 !== undefined) return ipv4;

  if (!raw.includes(":")) throw new Error("Invalid visitor address");

  let hostname: string;

  try {
    hostname = new URL(`http://[${raw}]/`).hostname;
  } catch {
    throw new Error("Invalid visitor address");
  }

  if (!hostname.startsWith("[") || !hostname.endsWith("]")) {
    throw new Error("Invalid visitor address");
  }

  const canonical = hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonical);

  if (mapped === null) return canonical;
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);

  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
};

export const CONTACT_INGRESS_HEADER = "x-vektor-contact-ingress";

export const CONTACT_BACKEND_HEADER = "x-vektor-contact-backend";

export const CONTACT_IP_HEADER = "x-vektor-contact-ip";

type ContactVisitorIp = ContactMessageHeaders[typeof CONTACT_IP_HEADER];

export type ContactIngress = {
  readonly backendOrigin: string;
  readonly visitorIp: ContactVisitorIp;
  readonly backendToken: string;
};

export const contactIngressContext = createContext<ContactIngress | null>(null);

export interface ContactWorkerBindings {
  readonly CONTACT_INGRESS_TOKEN?: string;
  readonly CONTACT_BACKEND_TOKEN?: string;
  readonly API_URL?: string;
}

/** Only the controlled ingress knows this hop's credential; forwarded headers alone confer no authority. */
export const authenticateContactIngress = (
  request: Request,
  env: ContactWorkerBindings,
): ContactIngress | null => {
  const ingressToken = env.CONTACT_INGRESS_TOKEN;
  const backendToken = env.CONTACT_BACKEND_TOKEN;

  if (
    !ingressToken ||
    !backendToken ||
    ingressToken.length < 32 ||
    backendToken.length < 32 ||
    ingressToken === backendToken ||
    request.headers.get(CONTACT_INGRESS_HEADER) !== ingressToken
  )
    return null;

  try {
    const origin = new URL(env.API_URL ?? "");

    if (
      origin.origin !== env.API_URL ||
      origin.username ||
      origin.password ||
      !["http:", "https:"].includes(origin.protocol)
    )
      return null;

    const visitorIp = Schema.decodeUnknownSync(ContactVisitorIpSchema)(
      canonicalContactIp(request.headers.get(CONTACT_IP_HEADER) ?? ""),
    );

    return { backendOrigin: origin.origin, backendToken, visitorIp };
  } catch {
    return null;
  }
};
