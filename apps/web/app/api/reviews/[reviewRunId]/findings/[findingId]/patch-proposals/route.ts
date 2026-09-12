import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const noStoreHeaders = { 'cache-control': 'no-store' };

export async function POST(
  _request: Request,
  context: { params: Promise<{ reviewRunId: string; findingId: string }> },
) {
  const apiUrl = process.env.WALKZ_API_URL;
  const repositoryId = process.env.WALKZ_REPOSITORY_ID;
  if (!apiUrl || !repositoryId) {
    return NextResponse.json(
      { error: 'patch_generation_unavailable' },
      { status: 503, headers: noStoreHeaders },
    );
  }
  const { reviewRunId, findingId } = await context.params;
  const session = (await cookies()).get('walkz_session')?.value;
  const response = await fetch(
    `${apiUrl.replace(/\/$/, '')}/api/repositories/${encodeURIComponent(repositoryId)}/reviews/${encodeURIComponent(reviewRunId)}/findings/${encodeURIComponent(findingId)}/patch-proposals`,
    {
      method: 'POST',
      cache: 'no-store',
      headers: session === undefined
        ? {}
        : { cookie: `walkz_session=${encodeURIComponent(session)}` },
    },
  );
  const body: unknown = await response.json();
  return NextResponse.json(body, { status: response.status, headers: noStoreHeaders });
}
