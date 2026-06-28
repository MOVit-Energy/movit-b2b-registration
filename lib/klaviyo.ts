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
