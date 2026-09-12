import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const noStoreHeaders = { 'cache-control': 'no-store' };

export async function POST(
  request: Request,
  context: { params: Promise<{ proposalId: string }> },
) {
  const apiUrl = process.env.WALKZ_API_URL;
  const repositoryId = process.env.WALKZ_REPOSITORY_ID;
  if (!apiUrl || !repositoryId) {
    return NextResponse.json(
      { error: 'patch_decision_unavailable' },
      { status: 503, headers: noStoreHeaders },
    );
  }
  const { proposalId } = await context.params;
  const session = (await cookies()).get('walkz_session')?.value;
  const body = await request.text();
  if (body.length > 2_048) {
    return NextResponse.json(
      { error: 'invalid_request' },
      { status: 413, headers: noStoreHeaders },
    );
  }
  const response = await fetch(
    `${apiUrl.replace(/\/$/, '')}/api/repositories/${encodeURIComponent(repositoryId)}/patch-proposals/${encodeURIComponent(proposalId)}/decision`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(session === undefined
          ? {}
          : { cookie: `walkz_session=${encodeURIComponent(session)}` }),
      },
      body,
    },
  );
  const responseBody: unknown = await response.json();
  return NextResponse.json(responseBody, {
    status: response.status,
    headers: noStoreHeaders,
  });
}
