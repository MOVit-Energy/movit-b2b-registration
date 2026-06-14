import { NextRequest, NextResponse } from 'next/server'
import { fetchAres, validateIco, AresNotFoundError } from '@/lib/ares'

export async function GET(request: NextRequest) {
  const ico = request.nextUrl.searchParams.get('ico') ?? ''

  if (!validateIco(ico)) {
    return NextResponse.json({ error: 'Neplatné IČO (musí mít 8 číslic s platným kontrolním součtem)' }, { status: 400 })
  }

  try {
    const subject = await fetchAres(ico)

    if (!subject.is_active) {
      return NextResponse.json({ error: 'Subjekt je v ARES evidován jako zaniklý' }, { status: 422 })
    }

    return NextResponse.json(subject)
  } catch (err) {
    if (err instanceof AresNotFoundError) {
      return NextResponse.json({ error: 'IČO nenalezeno v ARES, zkontrolujte ho prosím' }, { status: 404 })
    }
    console.error('[ares] fetch error', err)
    return NextResponse.json({ error: 'Chyba při komunikaci s ARES, zkuste to prosím znovu' }, { status: 502 })
  }
}
