import { NextRequest, NextResponse } from 'next/server'
import { recentMembersNeedingSms, subscribeSmsMarketing } from '@/lib/klaviyo'

// Vercel Pro: max 300s.
export const maxDuration = 300

// Denní auto-sync: nově přihlášení odběratelé newsletteru (list KLAVIYO_NEWSLETTER_LIST_ID),
// kteří mají telefon a ještě nejsou SMS SUBSCRIBED, se doplní k SMS marketingu
// i transactional. Běží 1x denně (viz vercel.json). Vercel cron posílá
// Authorization: Bearer ${CRON_SECRET}.
export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  // Okno 25 h (cron 1x denně + 1 h rezerva kvůli DST posunu).
  const since = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()

  console.log('[sync-sms-subscriptions] starting, since', since)
  try {
    const members = await recentMembersNeedingSms(since)
    let subscribed = 0
    for (let i = 0; i < members.length; i += 900) {
      const batch = members.slice(i, i + 900)
      await subscribeSmsMarketing(batch)
      subscribed += batch.length
    }
    const elapsed = Math.round((Date.now() - started) / 1000)
    console.log(`[sync-sms-subscriptions] done in ${elapsed}s, candidates=${members.length}, subscribed=${subscribed}`)
    return NextResponse.json({ ok: true, elapsed_s: elapsed, candidates: members.length, subscribed })
  } catch (err) {
    console.error('[sync-sms-subscriptions] fatal error', err)
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
