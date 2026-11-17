import { PlatformError } from "../shared.ts";

/**
 * The error every part of the LangSmith adapter throws. It lives in its own file so the parts can
 * import it without importing the factory in `index.ts` that imports them.
 */
export class LangSmithError extends PlatformError {
  constructor(message: string, status?: number) {
    super("langsmith", message, status);
  }
}
