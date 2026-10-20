/**
 * The credential of an `Authorization: Bearer <token>` header, or `undefined` for any other shape.
 * The scheme is matched case-insensitively (RFC 7235 section 2.1), so every surface that reads the
 * header accepts the same spellings.
 */
export function bearerToken(header: string | undefined): string | undefined {
  return header ? /^bearer\s+(\S+)\s*$/i.exec(header)?.[1] : undefined;
}

/** The headers an API key can arrive in; Express and Node both type them like this. */
interface KeyHeaders {
  'x-api-key'?: string | string[];
  authorization?: string | string[];
}

/**
 * The API key a request presents: the `X-API-Key` header, else an `Authorization: Bearer` token. Every
 * surface that authenticates a key reads it through here, so none of them can disagree on what the
 * credential is. A repeated header counts by its first value; an empty one is as good as absent.
 */
export function presentedApiKey(headers: KeyHeaders): string | undefined {
  const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
  return first(headers['x-api-key']) || bearerToken(first(headers.authorization));
}
