import { NextRequest, NextResponse } from 'next/server'
import { sendReplenishmentEmails } from '@/lib/replenishment'

// Manual trigger for testing/setup — bypasses the cron's day-of-week schedule,
// so it can be used any day to verify the flow end-to-end.
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token || token !== process.env.SYNC_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  console.log('[send-replenishment-emails][manual] starting')
  const started = Date.now()

  try {
    const result = await sendReplenishmentEmails()
    const elapsed = Math.round((Date.now() - started) / 1000)
    console.log(`[send-replenishment-emails][manual] done in ${elapsed}s`, result)
    return NextResponse.json({ ok: true, elapsed_s: elapsed, ...result })
  } catch (err) {
    console.error('[send-replenishment-emails][manual] fatal error', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
