export interface AresSubject {
  ico: string
  company_name: string
  dic: string | null
  is_vat_payer: boolean
  address: {
    street: string
    city: string
    zip: string
  }
  is_active: boolean
}

interface AresResponse {
  ico: string
  obchodniJmeno: string
  dic?: string
  sidlo: {
    textovaAdresa?: string
    nazevObce?: string
    psc?: number
    nazevUlice?: string
    cisloDomovni?: number
    cisloOrientacni?: number
  }
  stavSubjektu?: string
}

const cache = new Map<string, { data: AresSubject; expiresAt: number }>()
const CACHE_TTL = 24 * 60 * 60 * 1000

export function validateIco(ico: string): boolean {
  if (!/^\d{8}$/.test(ico)) return false

  const digits = ico.split('').map(Number)
  const weights = [8, 7, 6, 5, 4, 3, 2]
  const sum = weights.reduce((acc, w, i) => acc + w * digits[i], 0)
  const remainder = sum % 11
  let checkDigit: number
  if (remainder === 0) checkDigit = 1
  else if (remainder === 1) checkDigit = 0
  else checkDigit = 11 - remainder

  return digits[7] === checkDigit
}

export async function fetchAres(ico: string): Promise<AresSubject> {
  const cached = cache.get(ico)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data
  }

  const res = await fetch(
    `https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${ico}`,
    { headers: { Accept: 'application/json' }, next: { revalidate: 0 } }
  )

  if (res.status === 404) {
    throw new AresNotFoundError(`IČO ${ico} nebylo nalezeno v ARES`)
  }

  if (!res.ok) {
    throw new Error(`ARES API error: ${res.status}`)
  }

  const raw: AresResponse = await res.json()

  const sidlo = raw.sidlo ?? {}
  const street = [sidlo.nazevUlice, sidlo.cisloDomovni, sidlo.cisloOrientacni]
    .filter(Boolean)
    .join(' ') || sidlo.textovaAdresa || ''

  const subject: AresSubject = {
    ico: raw.ico,
    company_name: raw.obchodniJmeno,
    dic: raw.dic ?? null,
    is_vat_payer: !!raw.dic,
    address: {
      street,
      city: sidlo.nazevObce ?? '',
      zip: sidlo.psc ? String(sidlo.psc) : '',
    },
    is_active: raw.stavSubjektu !== 'ZANIKLÝ',
  }

  cache.set(ico, { data: subject, expiresAt: Date.now() + CACHE_TTL })

  return subject
}

export class AresNotFoundError extends Error {}
