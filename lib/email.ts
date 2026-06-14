import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY!)
const FROM = process.env.EMAIL_FROM!
const ADMIN = process.env.EMAIL_ADMIN!

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

interface EmailPayload {
  from: string
  to: string
  subject: string
  html: string
}

async function sendEmail(payload: EmailPayload): Promise<void> {
  console.log(
    '[email] odesílám\n' +
      `  from: ${payload.from}\n` +
      `  to: ${payload.to}\n` +
      `  subject: ${payload.subject}\n` +
      `  html:\n${payload.html}`
  )
  await resend.emails.send(payload)
}

export async function sendAdminNotification(data: ApplicationData): Promise<void> {
  await sendEmail({
    from: FROM,
    to: ADMIN,
    subject: `Nová B2B žádost: ${data.companyName} (${data.ico})`,
    html: adminEmailHtml(data),
  })
}

export async function sendWelcomeEmail(
  to: string,
  firstName: string,
  companyName: string,
  activationUrl: string
): Promise<void> {
  await sendEmail({
    from: FROM,
    to,
    subject: 'Vaše B2B registrace u MOVit Energy byla schválena',
    html: welcomeEmailHtml(firstName, companyName, activationUrl),
  })
}

export async function sendRejectionEmail(
  to: string,
  firstName: string
): Promise<void> {
  await sendEmail({
    from: FROM,
    to,
    subject: 'Vaše B2B žádost u MOVit Energy',
    html: rejectionEmailHtml(firstName),
  })
}

function adminEmailHtml(d: ApplicationData): string {
  return `<!DOCTYPE html>
<html lang="cs">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; }
  td { padding: 8px 12px; border-bottom: 1px solid #eee; }
  td:first-child { font-weight: bold; width: 200px; color: #555; }
  .cta { display: inline-block; padding: 14px 28px; border-radius: 4px; text-decoration: none; font-weight: bold; font-size: 16px; margin: 8px; }
  .approve { background: #16a34a; color: #fff; }
  .reject { background: #dc2626; color: #fff; }
  .actions { text-align: center; margin: 32px 0; }
  .note { background: #f9fafb; border-left: 4px solid #d1d5db; padding: 12px; margin: 16px 0; }
</style></head>
<body>
  <h2>Nová B2B žádost</h2>
  <table>
    <tr><td>Firma</td><td>${esc(d.companyName)}</td></tr>
    <tr><td>IČO</td><td>${esc(d.ico)}</td></tr>
    <tr><td>DIČ</td><td>${esc(d.dic ?? '—')}</td></tr>
    <tr><td>Plátce DPH</td><td>${d.isVatPayer ? 'Ano' : 'Ne'}</td></tr>
    <tr><td>Adresa</td><td>${esc(d.addressStreet)}, ${esc(d.addressZip)} ${esc(d.addressCity)}</td></tr>
    <tr><td>Kontakt</td><td>${esc(d.firstName)} ${esc(d.lastName)}</td></tr>
    <tr><td>Email</td><td>${esc(d.email)}</td></tr>
    <tr><td>Telefon</td><td>${esc(d.phone)}</td></tr>
    <tr><td>Předpokl. objem</td><td>${esc(d.expectedVolume)}</td></tr>
  </table>
  ${d.note ? `<div class="note"><strong>Poznámka:</strong><br>${esc(d.note)}</div>` : ''}
  <div class="actions">
    <a href="${esc(d.approveLink)}" class="cta approve">✓ Schválit</a>
    <a href="${esc(d.rejectLink)}" class="cta reject">✗ Zamítnout</a>
  </div>
  <p style="color:#999;font-size:12px">Po schválení se automaticky vytvoří Shopify B2B Company a přiřadí B2B katalog.</p>
</body>
</html>`
}

function welcomeEmailHtml(firstName: string, companyName: string, activationUrl: string): string {
  return `<!DOCTYPE html>
<html lang="cs">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
  .cta { display: inline-block; background: #16a34a; color: #fff; padding: 14px 28px; border-radius: 4px; text-decoration: none; font-weight: bold; font-size: 16px; margin: 24px 0; }
  .steps { background: #f9fafb; border-radius: 8px; padding: 16px 24px; }
  .steps li { margin: 8px 0; }
</style></head>
<body>
  <h2>Vítejte v MOVit Energy B2B</h2>
  <p>Dobrý den ${esc(firstName)},</p>
  <p>Vaše firma <strong>${esc(companyName)}</strong> byla schválena jako B2B partner MOVit Energy.</p>
  <div class="steps">
    <strong>Co dál:</strong>
    <ol class="steps">
      <li>Klikněte na tlačítko níže pro nastavení hesla a aktivaci účtu</li>
      <li>Po přihlášení uvidíte náš B2B katalog s velkoobchodními cenami</li>
      <li>Objednávky zadáváte standardně přes košík</li>
    </ol>
  </div>
  <div style="text-align:center">
    <a href="${esc(activationUrl)}" class="cta">Nastavit heslo a aktivovat účet</a>
  </div>
  <p>V případě dotazů nás kontaktujte na <a href="mailto:tomas.zaruba@movitenergy.cz">tomas.zaruba@movitenergy.cz</a>.</p>
  <p>Děkujeme za zájem o spolupráci.<br><strong>Tým MOVit Energy</strong></p>
</body>
</html>`
}

function rejectionEmailHtml(firstName: string): string {
  return `<!DOCTYPE html>
<html lang="cs">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
</style></head>
<body>
  <p>Dobrý den ${esc(firstName)},</p>
  <p>Děkujeme za zájem o B2B spolupráci s MOVit Energy.</p>
  <p>Bohužel Vaši žádost o registraci momentálně nemůžeme přijmout. Pokud máte zájem o objednávky našich produktů, můžete je standardně nakoupit na <a href="https://movitenergy.cz">movitenergy.cz</a>.</p>
  <p>V případě dotazů nás kontaktujte na <a href="mailto:tomas.zaruba@movitenergy.cz">tomas.zaruba@movitenergy.cz</a>.</p>
  <p>S pozdravem,<br><strong>Tým MOVit Energy</strong></p>
</body>
</html>`
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
