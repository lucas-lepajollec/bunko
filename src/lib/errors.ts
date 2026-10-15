export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function errorCode(error: unknown): string {
  return error instanceof AppError
    ? error.code
    : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
      ? 'UPSTREAM_TIMEOUT'
      : 'UPSTREAM_ERROR';
}
