import { ExternalNativeApi, reflectAccessSpec } from "@vektorprogrammet/http-api";
import { Option } from "effect";
import { makeNativePreflightMethodResolver } from "./native-preflight.js";

const externalNativeEndpoints = Object.values(ExternalNativeApi.groups).flatMap((group) =>
  Object.values(group.endpoints),
);

export interface NativePreflightAttachmentGap {
  readonly identifier: string;
  readonly method: string;
  readonly path: string;
}

/** Old endpoints that 0077.2 must replace with AccessSpec-annotated route attachments. */
export const externalNativePreflightAttachmentGaps: ReadonlyArray<NativePreflightAttachmentGap> =
  externalNativeEndpoints.flatMap((endpoint) =>
    Option.isSome(reflectAccessSpec(endpoint))
      ? []
      : [
          {
            identifier: endpoint.identifier,
            method: endpoint.method,
            path: endpoint.path,
          },
        ],
  );

/** Methods for the current NativeApi route graph. */
export const externalNativePreflightMethodsForPath =
  makeNativePreflightMethodResolver(externalNativeEndpoints);
