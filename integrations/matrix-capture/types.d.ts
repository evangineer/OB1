declare module "indexeddbshim/src/node-UnicodeIdentifiers" {
  export default function setGlobalVars(
    globalObject: typeof globalThis,
    options?: Record<string, unknown>
  ): void;
}
