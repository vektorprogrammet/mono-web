import { Layer, ManagedRuntime } from "effect";

/** Owns executable runtime construction for the backend composition root. */
export const makeBackendRuntime = <R, E>(layer: Layer.Layer<R, E, never>) =>
  ManagedRuntime.make(layer);
