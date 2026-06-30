import type { ApiKeyContext } from "./types.js";

declare module "hono" {
  interface ContextVariableMap {
    apiKey: ApiKeyContext;
  }
}
