import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { normalizePhone } from '@/lib/phone'
import { checkRateLimit } from '@/lib/rateLimit'
import { unsubscribeByPhone } from '@/lib/klaviyo'

// Odhlášení podle telefonu. Klaviyo nepodporuje SMS marketing pro náš obor,
// takže máme jen jedno odhlášení: najdeme profil podle telefonu a odhlásíme ho
// z e-mail marketingu + odebereme z newsletter listu (tím přestane chodit i SMS).
// Veřejný endpoint (CORS řeší middleware.ts). Telefon se normalizuje na E.164
// (ořez mezer/teček/pomlček zajišťuje normalizePhone).
const schema = z.object({
  phone: z.string().min(1),
})

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
  if (!checkRateLimit(ip, 10)) {
    return NextResponse.json({ error: 'Příliš mnoho požadavků. Zkuste to prosím za hodinu.' }, { status: 429 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Neplatný formát požadavku.' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Vyplňte prosím telefonní číslo.' }, { status: 422 })
  }

  const phone = normalizePhone(parsed.data.phone)
  if (!phone) {
    return NextResponse.json({ error: 'Zadané telefonní číslo není platné.' }, { status: 422 })
  }

  try {
    const { found } = await unsubscribeByPhone(phone)
    if (!found) {
      return NextResponse.json(
        { error: 'K tomuto číslu jsme nenašli žádný kontakt. Zkontrolujte prosím zadané číslo.' },
        { status: 404 }
      )
    }
  } catch (err) {
    console.error('[sms/unsubscribe]', err)
    return NextResponse.json({ error: 'Odhlášení se nezdařilo, zkuste to prosím později.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, message: 'Byli jste odhlášeni z našich sdělení.' })
}
