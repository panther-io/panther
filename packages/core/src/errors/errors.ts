import type { ErrorMapper } from "../types/policy.js";

/**
 * Standard Fentaris MCP-style error codes.
 * @pk
 */
export const FentarisErrorCode = {
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
        code: FentarisErrorCode.UpstreamError,
        message: error.message,
      };
    }

    return {
      code: FentarisErrorCode.InternalError,
      message: String(error),
    };
  }
}
