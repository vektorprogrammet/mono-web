import { createContext } from "react-router";
import {
  canonicalContactIp,
  ContactVisitorIp,
  CONTACT_INGRESS_HEADER,
  CONTACT_IP_HEADER,
} from "@vektorprogrammet/domain/contact";
import { Schema } from "effect";

export type ContactIngress = {
  readonly backendOrigin: string;
  readonly visitorIp: ContactVisitorIp;
  readonly backendToken: string;
};
export const contactIngressContext = createContext<ContactIngress | undefined>(undefined);
export interface ContactWorkerBindings {
  readonly CONTACT_INGRESS_TOKEN?: string;
  readonly CONTACT_BACKEND_TOKEN?: string;
  readonly API_URL?: string;
}
/** Only the controlled ingress knows this hop's credential; forwarded headers alone confer no authority. */
export const authenticateContactIngress = (
  request: Request,
  env: ContactWorkerBindings,
): ContactIngress | undefined => {
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
    return undefined;
  try {
    const origin = new URL(env.API_URL ?? "");
    if (
      origin.origin !== env.API_URL ||
      origin.username ||
      origin.password ||
      !["http:", "https:"].includes(origin.protocol)
    )
      return undefined;
    const visitorIp = Schema.decodeUnknownSync(ContactVisitorIp)(
      canonicalContactIp(request.headers.get(CONTACT_IP_HEADER) ?? ""),
    );
    return { backendOrigin: origin.origin, backendToken, visitorIp };
  } catch {
    return undefined;
  }
};
