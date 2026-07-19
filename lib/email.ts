// Notifikační fasáda. Zachovává původní API (sendAdminNotification / sendWelcomeEmail
// / sendRejectionEmail), aby se API routy nemusely měnit.
//
// - Zákaznické emaily (welcome, rejection) jdou přes Klaviyo jako transakční events.
//   Šablony i odesílatel se spravují v Klaviyo, dynamická data se předávají v properties.
// - Admin notifikace o nové žádosti jde do Slacku i e-mailem (oba s tlačítky
//   schválit/zamítnout). E-mail jde přes Klaviyo, příjemce je EMAIL_ADMIN.
import { trackEvent } from './klaviyo'
import { sendSlackAdminNotification } from './slack'

const ADMIN_EMAIL = process.env.EMAIL_ADMIN!

export interface ApplicationData {
  companyName: string
  ico: string
  dic: string | null
  isVatPayer: boolean
  addressStreet: string
  addressCity: string
  addressZip: string
  firstName: string
  lastName: string
  email: string
  phone: string
  expectedVolume: string
  note: string
  // Stav zákaznického účtu pro daný email:
  //  - 'new'      → email nemá účet, schválením vznikne nový zákaznický účet + firma
  //  - 'existing' → email už má B2C účet, schválením bude připojen k firmě
  accountState: 'new' | 'existing'
  approveLink: string
  rejectLink: string
}

// Lidsky čitelné upozornění pro admina o dopadu schválení na zákaznický účet.
export function accountStateNote(state: 'new' | 'existing'): string {
  return state === 'new'
    ? 'Tento email zatím nemá účet — schválením vznikne nový zákaznický účet a firma.'
    : '⚠️ Tento email už patří existujícímu B2C účtu — schválením bude tento účet připojen k firmě (zákazník o tom nemusí vědet).'
}

// Názvy metrik musí odpovídat triggerům Flows v Klaviyo adminu.
const METRIC_ADMIN = 'B2B New Application'
const METRIC_APPROVED = 'B2B Approved'
const METRIC_REJECTED = 'B2B Rejected'

export async function sendAdminNotification(data: ApplicationData): Promise<void> {
  // Slack i e-mail posíláme nezávisle — selhání jednoho kanálu nezablokuje druhý.
  const results = await Promise.allSettled([
    sendSlackAdminNotification(data),
    sendAdminNotificationEmail(data),
  ])
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('[email] admin notification channel failed', r.reason)
    }
  }
}

async function sendAdminNotificationEmail(data: ApplicationData): Promise<void> {
  // Příjemce je admin; data žádosti i schvalovací odkazy jsou v properties eventu.
  await trackEvent(
    METRIC_ADMIN,
    { email: ADMIN_EMAIL },
    {
      companyName: data.companyName,
      ico: data.ico,
      dic: data.dic ?? '—',
      isVatPayer: data.isVatPayer ? 'Ano' : 'Ne',
      address: `${data.addressStreet}, ${data.addressZip} ${data.addressCity}`,
      contactName: `${data.firstName} ${data.lastName}`,
      email: data.email,
      phone: data.phone,
      expectedVolume: data.expectedVolume,
      note: data.note || '—',
      accountState: data.accountState,
      accountStateNote: accountStateNote(data.accountState),
      approveLink: data.approveLink,
      rejectLink: data.rejectLink,
    }
  )
}

export async function sendWelcomeEmail(
  to: string,
  firstName: string,
  companyName: string,
  loginUrl: string,
  accountState: 'new' | 'existing' = 'existing'
): Promise<void> {
  // Přihlášení probíhá přes jednorázový kód na email (new customer accounts),
  // takže neposíláme aktivační odkaz — jen potvrzení schválení a odkaz na přihlášení.
  // accountState umožní v Klaviyo šabloně odlišit text pro nově založený vs.
  // existující (připojený) účet.
  await trackEvent(
    METRIC_APPROVED,
    { email: to, first_name: firstName },
    { companyName, loginUrl, accountState }
  )
}

export async function sendRejectionEmail(to: string, firstName: string): Promise<void> {
  await trackEvent(METRIC_REJECTED, { email: to, first_name: firstName }, {})
}
