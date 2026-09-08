import { NextRequest, NextResponse } from 'next/server'
import { sendOrderFollowups } from '@/lib/followup'

// Manual trigger for testing/setup — bypasses the send-hour gate the cron route
// applies, so it can be used any time of day to verify the flow end-to-end.
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token')
  if (!token || token !== process.env.SYNC_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  console.log('[send-order-followups][manual] starting')
  const started = Date.now()

  try {
    const result = await sendOrderFollowups()
    const elapsed = Math.round((Date.now() - started) / 1000)
    console.log(`[send-order-followups][manual] done in ${elapsed}s`, result)
    return NextResponse.json({ ok: true, elapsed_s: elapsed, ...result })
  } catch (err) {
    console.error('[send-order-followups][manual] fatal error', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
