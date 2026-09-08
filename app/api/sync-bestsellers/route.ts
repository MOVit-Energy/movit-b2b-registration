import { NextRequest, NextResponse } from 'next/server'
import { syncBestsellerRanks } from '@/lib/products'

// Manual trigger for testing/setup — same shape as the cron route but token-authed via query string.
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token || token !== process.env.SYNC_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  console.log('[sync-bestsellers][manual] starting')
  const started = Date.now()

  try {
    const result = await syncBestsellerRanks()
    const elapsed = Math.round((Date.now() - started) / 1000)
    console.log(`[sync-bestsellers][manual] done in ${elapsed}s`, result)
    return NextResponse.json({ ok: true, elapsed_s: elapsed, ...result })
  } catch (err) {
    console.error('[sync-bestsellers][manual] fatal error', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
