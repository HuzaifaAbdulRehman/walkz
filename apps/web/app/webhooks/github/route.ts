import { proxyToHostedApi } from '../../lib/hosted-api-proxy';

export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  return proxyToHostedApi(request, {
    apiUrl: process.env.WALKZ_API_URL,
    pathSegments: ['webhooks', 'github'],
  });
}
