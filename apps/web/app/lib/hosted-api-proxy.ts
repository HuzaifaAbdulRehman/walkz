const maximumBodyBytes = 1_048_576;
const maximumQueryLength = 4_096;
const maximumPathSegments = 32;
const maximumPathSegmentLength = 256;
const requestHeaderAllowlist = [
  'accept',
  'content-type',
  'cookie',
  'idempotency-key',
  'x-github-delivery',
  'x-github-event',
  'x-hub-signature-256',
] as const;
const responseHeaderAllowlist = [
  'cache-control',
  'content-type',
  'location',
  'set-cookie',
] as const;
const sessionCookieName = 'walkz_session';

export interface HostedApiProxyOptions {
  apiUrl: string | undefined;
  pathSegments: readonly string[];
  fetcher?: typeof fetch;
}

class ProxyRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: code },
    { status, headers: { 'cache-control': 'private, no-store' } },
  );
}

function parseApiUrl(value: string | undefined): URL {
  if (value === undefined || value.trim().length === 0) {
    throw new ProxyRequestError(503, 'hosted_api_unavailable');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProxyRequestError(503, 'hosted_api_unavailable');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ProxyRequestError(503, 'hosted_api_unavailable');
  }
  return url;
}

function buildTarget(
  request: Request,
  apiUrl: string | undefined,
  pathSegments: readonly string[],
): URL {
  if (pathSegments.length === 0 || pathSegments.length > maximumPathSegments) {
    throw new ProxyRequestError(404, 'gateway_route_not_found');
  }
  const encodedSegments = pathSegments.map((segment) => {
    if (
      segment.length === 0 ||
      segment.length > maximumPathSegmentLength ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\0')
    ) {
      throw new ProxyRequestError(404, 'gateway_route_not_found');
    }
    return encodeURIComponent(segment);
  });
  const requestUrl = new URL(request.url);
  if (requestUrl.search.length > maximumQueryLength) {
    throw new ProxyRequestError(414, 'gateway_query_too_long');
  }
  const target = parseApiUrl(apiUrl);
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = `${basePath}/${encodedSegments.join('/')}`;
  target.search = requestUrl.search;
  return target;
}

function forwardedRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of requestHeaderAllowlist) {
    const value = request.headers.get(name);
    if (value === null) continue;
    if (name === 'cookie') {
      const sessionCookie = value
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${sessionCookieName}=`));
      if (sessionCookie !== undefined) headers.set(name, sessionCookie);
      continue;
    }
    headers.set(name, value);
  }
  return headers;
}

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new ProxyRequestError(400, 'gateway_content_length_invalid');
    }
    if (Number(contentLength) > maximumBodyBytes) {
      throw new ProxyRequestError(413, 'gateway_body_too_large');
    }
  }
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBodyBytes) {
        await reader.cancel('gateway_body_too_large');
        throw new ProxyRequestError(413, 'gateway_body_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return receivedBytes === 0
    ? undefined
    : new Uint8Array(Buffer.concat(chunks, receivedBytes));
}

function forwardedResponse(upstream: Response): Response {
  const headers = new Headers({ 'cache-control': 'private, no-store' });
  for (const name of responseHeaderAllowlist) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const body = upstream.status === 204 || upstream.status === 304
    ? null
    : upstream.body;
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export async function proxyToHostedApi(
  request: Request,
  options: HostedApiProxyOptions,
): Promise<Response> {
  let target: URL;
  let body: Uint8Array<ArrayBuffer> | undefined;
  try {
    target = buildTarget(request, options.apiUrl, options.pathSegments);
    body = await boundedBody(request);
  } catch (error) {
    if (error instanceof ProxyRequestError) {
      return errorResponse(error.status, error.code);
    }
    return errorResponse(400, 'gateway_request_invalid');
  }

  try {
    const response = await (options.fetcher ?? fetch)(target, {
      method: request.method,
      headers: forwardedRequestHeaders(request),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body }),
    });
    return forwardedResponse(response);
  } catch {
    return errorResponse(502, 'hosted_api_request_failed');
  }
}
