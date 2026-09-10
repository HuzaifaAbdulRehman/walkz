import { proxyToHostedApi } from '../../lib/hosted-api-proxy';

export const dynamic = 'force-dynamic';

async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;
  return proxyToHostedApi(request, {
    apiUrl: process.env.WALKZ_API_URL,
    pathSegments: ['api', ...path],
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
