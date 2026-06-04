import type { ErrorMapper } from "./types.js";

/**
 * Standard Panther MCP-style error codes.
 * @pk
 */
export const PantherErrorCode = {
  PolicyDenied: -32030,
  Unauthorized: -32040,
  UpstreamError: -32050,
  InternalError: -32603,
} as const;

/**
 * Default error mapper for upstream and governance errors.
 * @pk
 */
export class DefaultErrorMapper implements ErrorMapper {
  mapError(error: unknown): { code: number; message: string } {
    if (error instanceof Error) {
      return {
        code: PantherErrorCode.UpstreamError,
        message: error.message,
      };
    }

    return {
      code: PantherErrorCode.InternalError,
      message: String(error),
    };
  }
}
