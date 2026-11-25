// Klaviyo client pro API-based transactional events.
// Místo přímého odeslání emailu posíláme do Klaviyo "event" (metriku) — na tu je
// v Klaviyo navázaný Flow s emailovou šablonou nastavenou jako "Transactional".
// Viz https://developers.klaviyo.com/en/docs/guide_to_setting_up_api_based_transactional_events

const PRIVATE_KEY = process.env.KLAVIYO_PRIVATE_KEY!
const REVISION = process.env.KLAVIYO_API_REVISION || '2025-04-15'
const ENDPOINT = 'https://a.klaviyo.com/api/events/'

export interface KlaviyoProfile {
  email: string
  first_name?: string
  last_name?: string
  phone_number?: string
}

/**
 * Odešle event do Klaviyo. Klaviyo na úspěch vrací 202 (prázdné tělo).
 * @param metricName Název metriky, na kterou je navázaný transakční Flow.
 * @param profile    Profil příjemce — Flow odešle email na profile.email.
 * @param properties Data šablony, v Klaviyo dostupná jako {{ event.<key> }}.
 */
export async function trackEvent(
  metricName: string,
  profile: KlaviyoProfile,
  properties: Record<string, unknown> = {}
): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${PRIVATE_KEY}`,
      revision: REVISION,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          metric: { data: { type: 'metric', attributes: { name: metricName } } },
          profile: { data: { type: 'profile', attributes: profile } },
          properties,
          time: new Date().toISOString(),
        },
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Klaviyo event "${metricName}" selhal (${res.status}): ${text}`)
  }
}

// ── Odhlášení z marketingu podle telefonu (odhlašovací stránka) ──────────────
// Klaviyo nepodporuje SMS marketing pro náš obor, takže máme jen JEDNO odhlášení:
// zákazník zadá telefon (ze SMS), najdeme profil a odhlásíme ho z e-mail
// marketingu + odebereme z newsletter listu. SMS publikum se odvozuje z tohoto
// listu, takže tím zákazník přestane dostávat i SMS.
const NEWSLETTER_LIST_ID = process.env.KLAVIYO_NEWSLETTER_LIST_ID || 'TV2NX6'
const API_BASE = 'https://a.klaviyo.com/api'

function klaviyoHeaders() {
  return {
    Authorization: `Klaviyo-API-Key ${PRIVATE_KEY}`,
    revision: REVISION,
    'Content-Type': 'application/json',
    accept: 'application/json',
  }
}

/** Najde e-mail profilu podle telefonu (E.164). Vrátí null, když profil není. */
async function findEmailByPhone(phoneE164: string): Promise<string | null> {
  const filter = encodeURIComponent(`equals(phone_number,"${phoneE164}")`)
  const res = await fetch(`${API_BASE}/profiles/?filter=${filter}&fields[profile]=email`, {
    headers: klaviyoHeaders(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Klaviyo profile lookup selhal (${res.status}): ${text}`)
  }
  const json: { data?: Array<{ attributes?: { email?: string | null } }> } = await res.json()
  return json.data?.[0]?.attributes?.email ?? null
}

/**
 * Odhlásí zákazníka podle telefonu z e-mail marketingu a odebere ho z newsletter
 * listu. Vrací { found }: false, když k číslu neexistuje profil.
 */
export async function unsubscribeByPhone(phoneE164: string): Promise<{ found: boolean }> {
  const email = await findEmailByPhone(phoneE164)
  if (!email) return { found: false }

  const res = await fetch(`${API_BASE}/profile-subscription-bulk-delete-jobs/`, {
    method: 'POST',
    headers: klaviyoHeaders(),
    body: JSON.stringify({
      data: {
        type: 'profile-subscription-bulk-delete-job',
        attributes: {
          profiles: { data: [{ type: 'profile', attributes: { email } }] },
        },
        relationships: { list: { data: { type: 'list', id: NEWSLETTER_LIST_ID } } },
      },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Klaviyo unsubscribe selhal (${res.status}): ${text}`)
  }
  return { found: true }
}
