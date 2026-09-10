import { proxyToHostedApi } from '../../../lib/hosted-api-proxy';

export const dynamic = 'force-dynamic';

const allowedMethods = new Map([
  ['start', 'GET'],
  ['callback', 'GET'],
  ['logout', 'POST'],
]);

async function handle(
  request: Request,
  context: { params: Promise<{ action: string }> },
): Promise<Response> {
  const { action } = await context.params;
  const expectedMethod = allowedMethods.get(action);
  if (expectedMethod === undefined) {
    return Response.json(
      { error: 'gateway_route_not_found' },
      { status: 404, headers: { 'cache-control': 'private, no-store' } },
    );
  }
  if (request.method !== expectedMethod) {
    return Response.json(
      { error: 'method_not_allowed' },
      {
        status: 405,
        headers: {
          allow: expectedMethod,
          'cache-control': 'private, no-store',
        },
      },
    );
  }
  return proxyToHostedApi(request, {
    apiUrl: process.env.WALKZ_API_URL,
    pathSegments: ['auth', 'github', action],
  });
}

export const GET = handle;
export const POST = handle;
