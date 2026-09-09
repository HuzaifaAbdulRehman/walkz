import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { loadDashboardFindings } from '../../../../lib/reviews';

export const dynamic = 'force-dynamic';

const noStoreHeaders = { 'cache-control': 'no-store' };

export async function GET(
  _request: Request,
  context: { params: Promise<{ reviewRunId: string }> },
) {
  const { reviewRunId } = await context.params;
  const session = (await cookies()).get('walkz_session')?.value;
  const cookie = session === undefined
    ? undefined
    : `walkz_session=${encodeURIComponent(session)}`;
  try {
    const findings = await loadDashboardFindings(
      process.env.WALKZ_API_URL,
      process.env.WALKZ_REPOSITORY_ID,
      reviewRunId,
      cookie,
    );
    return NextResponse.json({ findings }, { headers: noStoreHeaders });
  } catch {
    return NextResponse.json(
      { error: 'review_findings_unavailable' },
      { status: 503, headers: noStoreHeaders },
    );
  }
}
