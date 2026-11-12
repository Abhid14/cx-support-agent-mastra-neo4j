import { AsyncLocalStorage } from "node:async_hooks";
// Carries the server-owned conversation ID into tool execution without model input.
export const supportSession = new AsyncLocalStorage<string>();
