import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { loadDashboardReviews } from '../../lib/reviews';

export const dynamic = 'force-dynamic';

const noStoreHeaders = { 'cache-control': 'no-store' };

export async function GET() {
  const session = (await cookies()).get('walkz_session')?.value;
  const cookie = session === undefined ? undefined : `walkz_session=${encodeURIComponent(session)}`;
  try {
    const reviews = await loadDashboardReviews(
      process.env.WALKZ_API_URL,
      process.env.WALKZ_REPOSITORY_ID,
      cookie,
    );
    return NextResponse.json({ reviews }, { headers: noStoreHeaders });
  } catch {
    return NextResponse.json(
      { error: 'review_history_unavailable' },
      { status: 503, headers: noStoreHeaders },
    );
  }
}
