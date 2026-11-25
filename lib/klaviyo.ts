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

// ── SMS consent management (odhlašovací stránka + denní sync) ────────────────
// Newsletter list, ze kterého se dohánějí SMS subscripce (viz cron sync-sms-subscriptions).
const SMS_LIST_ID = process.env.KLAVIYO_NEWSLETTER_LIST_ID || 'TV2NX6'
const API_BASE = 'https://a.klaviyo.com/api'

function klaviyoHeaders() {
  return {
    Authorization: `Klaviyo-API-Key ${PRIVATE_KEY}`,
    revision: REVISION,
    'Content-Type': 'application/json',
    accept: 'application/json',
  }
}

/**
 * Odhlásí telefon z SMS marketingu (globálně — SMS consent není vázaný na list).
 * Telefon musí být v E.164. Klaviyo na úspěch vrací 202 (async job).
 */
export async function unsubscribeSmsByPhone(phoneE164: string): Promise<void> {
  const res = await fetch(`${API_BASE}/profile-subscription-bulk-delete-jobs/`, {
    method: 'POST',
    headers: klaviyoHeaders(),
    body: JSON.stringify({
      data: {
        type: 'profile-subscription-bulk-delete-job',
        attributes: {
          profiles: { data: [{ type: 'profile', attributes: { phone_number: phoneE164 } }] },
        },
      },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Klaviyo SMS unsubscribe selhal (${res.status}): ${text}`)
  }
}

interface SmsSubProfile {
  phone_number: string
  email?: string
}

/**
 * Přihlásí dávku profilů k SMS marketingu i transactional (list SMS_LIST_ID).
 * Max ~900 profilů na volání. Klaviyo vrací 202.
 */
export async function subscribeSmsMarketing(profiles: SmsSubProfile[]): Promise<void> {
  if (profiles.length === 0) return
  const res = await fetch(`${API_BASE}/profile-subscription-bulk-create-jobs/`, {
    method: 'POST',
    headers: klaviyoHeaders(),
    body: JSON.stringify({
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: {
          custom_source: 'Newsletter->SMS auto-sync',
          profiles: {
            data: profiles.map(p => ({
              type: 'profile',
              attributes: {
                phone_number: p.phone_number,
                ...(p.email ? { email: p.email } : {}),
                subscriptions: {
                  sms: {
                    marketing: { consent: 'SUBSCRIBED' },
                    transactional: { consent: 'SUBSCRIBED' },
                  },
                },
              },
            })),
          },
        },
        relationships: { list: { data: { type: 'list', id: SMS_LIST_ID } } },
      },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Klaviyo SMS subscribe selhal (${res.status}): ${text}`)
  }
}

interface ListProfile {
  phone_number: string | null
  email: string | null
  sms_consent: string | null
}

/**
 * Vrátí členy newsletter listu, kteří se přidali od `sinceIso`, mají telefon a
 * zároveň ještě nejsou SMS SUBSCRIBED. Použito denním cronem k doplnění SMS.
 */
export async function recentMembersNeedingSms(sinceIso: string): Promise<SmsSubProfile[]> {
  const out: SmsSubProfile[] = []
  const fields =
    'fields[profile]=email,phone_number,subscriptions.sms.marketing.consent' +
    '&additional-fields[profile]=subscriptions'
  const filter = encodeURIComponent(`greater-or-equal(joined_group_at,${sinceIso})`)
  let url: string | null =
    `${API_BASE}/lists/${SMS_LIST_ID}/profiles/?filter=${filter}&${fields}&page[size]=100`

  while (url) {
    const res = await fetch(url, { headers: klaviyoHeaders() })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Klaviyo list profiles selhal (${res.status}): ${text}`)
    }
    const json: {
      data: Array<{ attributes: { email: string | null; phone_number: string | null; subscriptions?: { sms?: { marketing?: { consent?: string } } } } }>
      links?: { next?: string | null }
    } = await res.json()

    for (const p of json.data) {
      const a = p.attributes
      const phone = a.phone_number
      const consent = a.subscriptions?.sms?.marketing?.consent ?? null
      const email = a.email ?? ''
      if (!phone) continue
      if (consent === 'SUBSCRIBED') continue
      if (email.toLowerCase().endsWith('@movitenergy.cz')) continue // interní/test
      out.push({ phone_number: phone, email: email || undefined })
    }
    url = json.links?.next ?? null
  }
  return out
}
