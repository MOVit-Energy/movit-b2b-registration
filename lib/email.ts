// Notifikační fasáda. Zachovává původní API (sendAdminNotification / sendWelcomeEmail
// / sendRejectionEmail), aby se API routy nemusely měnit.
//
// - Zákaznické emaily (welcome, rejection) jdou přes Klaviyo jako transakční events.
//   Šablony i odesílatel se spravují v Klaviyo, dynamická data se předávají v properties.
// - Admin notifikace o nové žádosti jde do Slacku.
import { trackEvent } from './klaviyo'
import { sendSlackAdminNotification } from './slack'

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
  approveLink: string
  rejectLink: string
}

// Názvy metrik musí odpovídat triggerům Flows v Klaviyo adminu.
const METRIC_APPROVED = 'B2B Approved'
const METRIC_REJECTED = 'B2B Rejected'

export async function sendAdminNotification(data: ApplicationData): Promise<void> {
  await sendSlackAdminNotification(data)
}

export async function sendWelcomeEmail(
  to: string,
  firstName: string,
  companyName: string,
  loginUrl: string
): Promise<void> {
  // Customer už má aktivní účet (registroval se před vyplněním formuláře), takže
  // neposíláme aktivační odkaz — jen potvrzení schválení a odkaz na přihlášení.
  await trackEvent(
    METRIC_APPROVED,
    { email: to, first_name: firstName },
    { companyName, loginUrl }
  )
}

export async function sendRejectionEmail(to: string, firstName: string): Promise<void> {
  await trackEvent(METRIC_REJECTED, { email: to, first_name: firstName }, {})
}
