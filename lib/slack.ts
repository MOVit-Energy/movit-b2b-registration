// Slack notifikace pro admina (nová B2B žádost) přes Incoming Webhook.
// Webhook URL nastav v Slacku: Apps → Incoming Webhooks → Add to channel.
import type { ApplicationData } from './email'

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL!

export async function sendSlackAdminNotification(d: ApplicationData): Promise<void> {
  const fields = [
    ['Firma', d.companyName],
    ['IČO', d.ico],
    ['DIČ', d.dic ?? '—'],
    ['Plátce DPH', d.isVatPayer ? 'Ano' : 'Ne'],
    ['Adresa', `${d.addressStreet}, ${d.addressZip} ${d.addressCity}`],
    ['Kontakt', `${d.firstName} ${d.lastName}`],
    ['Email', d.email],
    ['Telefon', d.phone],
    ['Předpokl. objem', d.expectedVolume],
  ].map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}:*\n${v}` }))

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `🆕 Nová B2B žádost: ${d.companyName}` } },
    { type: 'section', fields },
  ]

  if (d.note) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Poznámka:*\n${d.note}` } })
  }

  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: '✓ Schválit' }, style: 'primary', url: d.approveLink },
      { type: 'button', text: { type: 'plain_text', text: '✗ Zamítnout' }, style: 'danger', url: d.rejectLink },
    ],
  })

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `Nová B2B žádost: ${d.companyName} (${d.ico})`, blocks }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Slack notifikace selhala (${res.status}): ${text}`)
  }
}
