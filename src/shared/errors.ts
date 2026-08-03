export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = 'app_error',
    public details?: unknown
  ) {
    super(message);
  }
}

export function notFound(resource: string): AppError {
  return new AppError(404, `${resource} not found`, 'not_found');
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError(400, message, 'bad_request', details);
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError(409, message, 'conflict', details);
}

export function forbidden(message: string, details?: unknown): AppError {
  return new AppError(403, message, 'forbidden', details);
}

/**
 * An upstream provider is down or rejecting us.
 *
 * 503, not 500. "Internal server error" tells a user we crashed and tells an
 * operator nothing; a revoked Breet key is neither of those things. Added
 * because a rotated sandbox key made GET /api/ngn/banks return a bare 500 and
 * the bank picker rendered empty with no explanation.
 */
export function serviceUnavailable(message: string, details?: unknown): AppError {
  return new AppError(503, message, 'service_unavailable', details);
}
