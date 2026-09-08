import { NextRequest, NextResponse } from 'next/server'
import { sendOrderFollowups } from '@/lib/followup'

// Vercel Pro: max 300s, Hobby: max 60s
export const maxDuration = 300

// Cron běží 1x denně v pevný UTC čas (viz vercel.json — Hobby plán nepodporuje
// hodinový cron, takže odpadá možnost dynamicky hlídat 7:00 Europe/Prague přes
// DST). "0 6 * * *" odpovídá 7:00 v zimním čase (CET) / 8:00 v letním čase (CEST) —
// pokud vadí ten cca hodinový posun 2x ročně, uprav schedule ve vercel.json.
export async function GET(request: NextRequest) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` automatically.
  const auth = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  console.log('[send-order-followups] starting')
  const started = Date.now()

  try {
    const result = await sendOrderFollowups()
    const elapsed = Math.round((Date.now() - started) / 1000)
    console.log(`[send-order-followups] done in ${elapsed}s`, result)
    return NextResponse.json({ ok: true, elapsed_s: elapsed, ...result })
  } catch (err) {
    console.error('[send-order-followups] fatal error', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
