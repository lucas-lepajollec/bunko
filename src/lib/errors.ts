export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public detail: string | null = null,
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

/** Never retain/log an upstream body. Redact before truncating (a URL may exceed the limit). */
export function sanitizeDetail(message: string, secrets: string[] = []): string | null {
  let line = message.split(/[\r\n]/, 1)[0];
  for (const secret of secrets.filter(Boolean)) line = line.split(secret).join('[redacted]');
  line = line
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"']+/gi, '[url]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:\/[^\s<>"']*)?/gi, '[url]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[redacted]')
    .replace(
      /\b(?:password|passwd|(?:access[_ -]?|refresh[_ -]?|id[_ -]?)?token|api[_ -]?key|secret|authorization|cookie|session(?:id)?)\b\s*[:=]\s*.*$/gi,
      '[redacted]',
    )
    .replace(/\?[^\s<>"']+/g, '[query]')
    .replace(/\b[A-Za-z0-9_+\/=-]{24,}\b/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return line.slice(0, 140) || null;
}
export function sourceFailure(message: string, secrets: string[] = []) {
  const code = /cloudflare|cf-chl|challenge|403.*\bcf\b|\bcf\b.*403/i.test(message)
    ? 'CLOUDFLARE'
    : /log[- ]?in|sign[- ]?in|logged in|authenticat(?:ion|e)(?: is)? required|requires authentication|please authenticate|unauthenticated|authentication failed|unauthorized/i.test(
          message,
        )
      ? 'SOURCE_LOGIN_REQUIRED'
      : /(?:http(?:\s+(?:error|status|code))?[^\d\r\n]{0,12}[1-5]\d{2}|status(?:\s+code)?\s*[:=]?\s*[1-5]\d{2})/i.test(
            message,
          )
        ? 'SOURCE_HTTP_ERROR'
        : 'SUWAYOMI_GRAPHQL_ERROR';
  return new AppError(
    code,
    'Suwayomi source operation failed',
    502,
    sanitizeDetail(message, secrets),
  );
}
export function errorDetail(error: unknown): string | null {
  return error instanceof AppError ? error.detail : null;
}
