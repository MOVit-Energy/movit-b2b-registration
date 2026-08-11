// Shopify adresy telefon validují a neplatné číslo shodí celou mutaci — u
// companyCreate by tím padla celá registrace. Číslo z formuláře proto před
// vložením do adresy převedeme na E.164 a když se to nepovede, do adresy ho
// vůbec neposíláme (v metafieldu custom.contact_phone zůstane tak, jak ho
// zákazník napsal).

// Mezery, tečky, pomlčky, lomítka a závorky jsou v zápisu telefonu běžné.
const SEPARATORS = /[\s.\-()/]/g

// E.164: 8–15 číslic včetně předvolby, bez vodicí nuly.
const E164_DIGITS = /^[1-9]\d{7,14}$/

export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(SEPARATORS, '')
  if (!compact) return null

  let digits: string
  if (compact.startsWith('+')) {
    digits = compact.slice(1)
  } else if (compact.startsWith('00')) {
    // Mezinárodní předvolba zapsaná jako 00 místo +.
    digits = compact.slice(2)
  } else if (/^\d{9}$/.test(compact)) {
    // Devítimístné číslo bez předvolby je české (777123456).
    digits = `420${compact}`
  } else {
    digits = compact
  }

  if (!E164_DIGITS.test(digits)) return null
  return `+${digits}`
}
