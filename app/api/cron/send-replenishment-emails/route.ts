import { NextRequest, NextResponse } from 'next/server'
import { sendReplenishmentEmails } from '@/lib/replenishment'

// Vercel Pro: max 300s, Hobby: max 60s
export const maxDuration = 300

// Cron schedule (vercel.json) obsahuje den v týdnu "0,1,2,3,4" (Ne-Čt), takže
// se v Pá/So vůbec nespustí — žádný in-code gate navíc není potřeba.
export async function GET(request: NextRequest) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` automatically.
  const auth = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  console.log('[send-replenishment-emails] starting')
  const started = Date.now()

  try {
    const result = await sendReplenishmentEmails()
    const elapsed = Math.round((Date.now() - started) / 1000)
    console.log(`[send-replenishment-emails] done in ${elapsed}s`, result)
    return NextResponse.json({ ok: true, elapsed_s: elapsed, ...result })
  } catch (err) {
    console.error('[send-replenishment-emails] fatal error', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
