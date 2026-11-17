/**
 * The error every part of the Langfuse adapter throws. It lives in its own file so the capability
 * modules can throw it without importing `index.ts`, which imports them.
 */
import { PlatformError } from "../shared.ts";

/** Langfuse answered with an error, or holds something this SDK cannot represent. `status` is set for HTTP failures. */
export class LangfuseError extends PlatformError {
  constructor(message: string, status?: number) {
    super("langfuse", message, status);
  }
}
