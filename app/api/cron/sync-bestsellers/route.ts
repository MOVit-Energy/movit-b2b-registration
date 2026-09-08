import { NextRequest, NextResponse } from 'next/server'
import { syncBestsellerRanks } from '@/lib/products'

// Vercel Pro: max 300s, Hobby: max 60s
export const maxDuration = 300

export async function GET(request: NextRequest) {
  // Vercel cron sends `Authorization: Bearer ${CRON_SECRET}` automatically.
  const auth = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  console.log('[sync-bestsellers] starting')
  const started = Date.now()

  try {
    const result = await syncBestsellerRanks()
    const elapsed = Math.round((Date.now() - started) / 1000)
    console.log(`[sync-bestsellers] done in ${elapsed}s`, result)
    return NextResponse.json({ ok: true, elapsed_s: elapsed, ...result })
  } catch (err) {
    console.error('[sync-bestsellers] fatal error', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
