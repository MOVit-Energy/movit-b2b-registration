import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { fetchAres, validateIco, AresNotFoundError } from '@/lib/ares'
import { shopifyGraphQL } from '@/lib/shopify'
import { signToken } from '@/lib/token'
import { sendAdminNotification } from '@/lib/email'
import { checkRateLimit } from '@/lib/rateLimit'

// Veřejná URL této aplikace (kde běží /api/b2b/approve|reject), ne storefront.
// Ořežeme případné koncové lomítko, ať nevznikne "//api" ve schvalovacích odkazech.
const APP_URL = process.env.APP_URL!.replace(/\/+$/, '')

const schema = z.object({
  customer_id: z.string().regex(/^\d+$/, 'Neplatné customer ID'),
  ico: z.string().refine(validateIco, 'Neplatné IČO'),
  company_name: z.string().min(1),
  dic: z.string().optional(),
  is_vat_payer: z.boolean(),
  address_street: z.string().min(1),
  address_city: z.string().min(1),
  address_zip: z.string().min(1),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  expected_volume: z.enum(['do-10k', '10-50k', '50-200k', 'nad-200k']),
  note: z.string().optional().default(''),
  consent: z.literal(true),
})

// Company vytvoříme hned po odeslání formuláře. Kontakt (customer) se nezakládá —
// vznikne až při approve. Veškerá data žádosti proto ukládáme jako metafieldy
// na company.
const COMPANY_CREATE = `
  mutation companyCreate($input: CompanyCreateInput!) {
    companyCreate(input: $input) {
      company { id }
      userErrors { field message code }
    }
  }
`

const METAFIELDS_SET = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`

// Výchozí splatnost nové firmy: Net 15. Payment terms šablony jsou společné pro
// celý Shopify, jejich ID je ale per-shop, takže ho dohledáme za běhu a cacheneme.
const PAYMENT_TERMS_TEMPLATES = `
  query paymentTermsTemplates {
    paymentTermsTemplates(paymentTermsType: NET) {
      id
      dueInDays
    }
  }
`

let cachedNet15TemplateId: string | null | undefined

async function getNet15TemplateId(): Promise<string | null> {
  if (cachedNet15TemplateId !== undefined) return cachedNet15TemplateId

  type Result = { paymentTermsTemplates: { id: string; dueInDays: number | null }[] }
  const { paymentTermsTemplates } = await shopifyGraphQL<Result>(PAYMENT_TERMS_TEMPLATES)
  cachedNet15TemplateId = paymentTermsTemplates.find(t => t.dueInDays === 15)?.id ?? null
  if (!cachedNet15TemplateId) {
    console.error('[submit] Net 15 payment terms template not found')
  }
  return cachedNet15TemplateId
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'Příliš mnoho žádostí. Zkuste to za hodinu.' }, { status: 429 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Neplatný formát požadavku' }, { status: 400 })
  }

  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Neplatná data', details: parsed.error.flatten() }, { status: 422 })
  }

  const d = parsed.data
  const customerGid = `gid://shopify/Customer/${d.customer_id}`

  // Backend ARES re-check
  try {
    const ares = await fetchAres(d.ico)
    if (!ares.is_active) {
      return NextResponse.json({ error: 'IČO odpovídá zaniklému subjektu v ARES' }, { status: 422 })
    }
  } catch (err) {
    if (err instanceof AresNotFoundError) {
      return NextResponse.json({ error: 'IČO nenalezeno v ARES' }, { status: 422 })
    }
    console.error('[submit] ARES error', err)
    return NextResponse.json({ error: 'Nelze ověřit IČO v ARES, zkuste to prosím znovu' }, { status: 502 })
  }

  // Vytvoříme B2B Company + lokaci s adresou. Kontakt přiřadíme až při approve.
  type CompanyCreateResult = {
    companyCreate: {
      company: { id: string } | null
      userErrors: { field: string[]; message: string; code: string }[]
    }
  }

  const net15TemplateId = await getNet15TemplateId()

  let companyId: string
  try {
    const result = await shopifyGraphQL<CompanyCreateResult>(COMPANY_CREATE, {
      input: {
        company: {
          name: d.company_name,
          externalId: d.ico,
          note: `DIČ: ${d.dic || '—'} | Objem: ${d.expected_volume}`,
        },
        companyLocation: {
          name: d.company_name,
          shippingAddress: {
            firstName: d.first_name,
            lastName: d.last_name,
            address1: d.address_street,
            city: d.address_city,
            zip: d.address_zip,
            countryCode: 'CZ',
          },
          billingSameAsShipping: true,
          // Výchozí splatnost Net 15. Pokud šablonu nedohledáme, firmu založíme bez ní.
          ...(net15TemplateId
            ? { buyerExperienceConfiguration: { paymentTermsTemplateId: net15TemplateId } }
            : {}),
        },
      },
    })

    const errors = result.companyCreate.userErrors
    if (errors.length > 0) {
      const isDuplicate = errors.some(e => e.code === 'TAKEN' || e.message.toLowerCase().includes('external'))
      if (isDuplicate) {
        return NextResponse.json({ error: `Firma s IČO ${d.ico} je již registrována.` }, { status: 409 })
      }
      throw new Error(`companyCreate errors: ${JSON.stringify(errors)}`)
    }

    companyId = result.companyCreate.company!.id
  } catch (err) {
    console.error('[submit] companyCreate error', err)
    return NextResponse.json({ error: 'Chyba při vytváření firmy' }, { status: 500 })
  }

  // Schvalovací token a odkazy (token referencuje company).
  const token = signToken(companyId, d.email)
  const approveLink = `${APP_URL}/api/b2b/approve?token=${encodeURIComponent(token)}`
  const rejectLink = `${APP_URL}/api/b2b/reject?token=${encodeURIComponent(token)}`

  // Uložíme data žádosti + kontakt + schvalovací odkazy jako metafieldy na company.
  try {
    const metafields = [
      { ownerId: companyId, namespace: 'custom', key: 'customer', type: 'customer_reference', value: customerGid },
      { ownerId: companyId, namespace: 'custom', key: 'dic', type: 'single_line_text_field', value: d.dic ?? '' },
      { ownerId: companyId, namespace: 'custom', key: 'is_vat_payer', type: 'boolean', value: String(d.is_vat_payer) },
      { ownerId: companyId, namespace: 'custom', key: 'expected_volume', type: 'single_line_text_field', value: d.expected_volume },
      { ownerId: companyId, namespace: 'custom', key: 'application_note', type: 'multi_line_text_field', value: d.note },
      { ownerId: companyId, namespace: 'custom', key: 'applied_at', type: 'date_time', value: new Date().toISOString() },
      { ownerId: companyId, namespace: 'custom', key: 'contact_first_name', type: 'single_line_text_field', value: d.first_name },
      { ownerId: companyId, namespace: 'custom', key: 'contact_last_name', type: 'single_line_text_field', value: d.last_name },
      { ownerId: companyId, namespace: 'custom', key: 'contact_email', type: 'single_line_text_field', value: d.email },
      { ownerId: companyId, namespace: 'custom', key: 'contact_phone', type: 'single_line_text_field', value: d.phone },
      { ownerId: companyId, namespace: 'custom', key: 'approve_url', type: 'url', value: approveLink },
      { ownerId: companyId, namespace: 'custom', key: 'reject_url', type: 'url', value: rejectLink },
      { ownerId: companyId, namespace: 'custom', key: 'approval_token_used', type: 'boolean', value: 'false' },
      { ownerId: companyId, namespace: 'custom', key: 'b2b_status', type: 'single_line_text_field', value: 'pending' },
    ]

    await shopifyGraphQL(METAFIELDS_SET, { metafields })
  } catch (err) {
    console.error('[submit] metafieldsSet error', err)
    // Non-fatal — company existuje, odkazy jsou i ve Slacku
  }

  // Admin notifikace (Slack)
  try {
    await sendAdminNotification({
      companyName: d.company_name,
      ico: d.ico,
      dic: d.dic ?? null,
      isVatPayer: d.is_vat_payer,
      addressStreet: d.address_street,
      addressCity: d.address_city,
      addressZip: d.address_zip,
      firstName: d.first_name,
      lastName: d.last_name,
      email: d.email,
      phone: d.phone,
      expectedVolume: d.expected_volume,
      note: d.note,
      approveLink,
      rejectLink,
    })
  } catch (err) {
    console.error('[submit] sendAdminNotification error', err)
    // Non-fatal — žádost je uložena v Shopify
  }

  console.log(`[submit] new B2B application companyId=${companyId} ico=${d.ico}`)
  return NextResponse.json({ ok: true, message: 'Žádost přijata' })
}
