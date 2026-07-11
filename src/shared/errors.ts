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
