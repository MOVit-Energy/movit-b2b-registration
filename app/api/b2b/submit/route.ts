import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { fetchAres, validateIco, AresNotFoundError } from '@/lib/ares'
import { shopifyGraphQL } from '@/lib/shopify'
import { signToken } from '@/lib/token'
import { sendAdminNotification } from '@/lib/email'
import { checkRateLimit } from '@/lib/rateLimit'

// Veřejná URL této aplikace (kde běží /api/b2b/approve|reject), ne storefront.
const APP_URL = process.env.APP_URL!

const schema = z.object({
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

const CUSTOMER_CREATE = `
  mutation customerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id email }
      userErrors { field message }
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

const CUSTOMER_BY_EMAIL = `
  query customerByEmail($query: String!) {
    customers(first: 1, query: $query) {
      nodes { id tags }
    }
  }
`

const CUSTOMER_UPDATE = `
  mutation customerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`

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

  // Create Shopify customer
  type CustomerCreateResult = {
    customerCreate: {
      customer: { id: string; email: string } | null
      userErrors: { field: string[]; message: string }[]
    }
  }
  type CustomerByEmailResult = {
    customers: { nodes: { id: string; tags: string[] }[] }
  }

  let customerId: string
  try {
    const result = await shopifyGraphQL<CustomerCreateResult>(CUSTOMER_CREATE, {
      input: {
        email: d.email,
        firstName: d.first_name,
        lastName: d.last_name,
        phone: d.phone,
        tags: ['b2b-pending'],
        note: 'B2B žádost - viz metafieldy',
      },
    })

    const errors = result.customerCreate.userErrors
    if (errors.length > 0) {
      const emailTaken = errors.some(e => e.message.toLowerCase().includes('email'))
      if (emailTaken) {
        // Zákazník už existuje — nevytváříme nového, jen ho najdeme a níže
        // doplníme/aktualizujeme custom fieldy (metafieldy).
        const found = await shopifyGraphQL<CustomerByEmailResult>(CUSTOMER_BY_EMAIL, {
          query: `email:${d.email}`,
        })
        const existing = found.customers.nodes[0]
        if (!existing) {
          throw new Error('Email obsazen, ale existující zákazník nenalezen')
        }
        customerId = existing.id

        // Přidáme tag b2b-pending (zachováme stávající tagy).
        const tags = Array.from(new Set([...existing.tags, 'b2b-pending']))
        await shopifyGraphQL(CUSTOMER_UPDATE, {
          input: {
            id: customerId,
            firstName: d.first_name,
            lastName: d.last_name,
            phone: d.phone,
            tags,
          },
        })
      } else {
        throw new Error(`customerCreate errors: ${JSON.stringify(errors)}`)
      }
    } else {
      customerId = result.customerCreate.customer!.id
    }
  } catch (err) {
    console.error('[submit] customerCreate/update error', err)
    return NextResponse.json({ error: 'Chyba při vytváření zákazníka' }, { status: 500 })
  }

  // Save metafields
  try {
    const metafields = [
      { ownerId: customerId, namespace: 'custom', key: 'company_name', type: 'single_line_text_field', value: d.company_name },
      { ownerId: customerId, namespace: 'custom', key: 'ico', type: 'single_line_text_field', value: d.ico },
      { ownerId: customerId, namespace: 'custom', key: 'dic', type: 'single_line_text_field', value: d.dic ?? '' },
      { ownerId: customerId, namespace: 'custom', key: 'is_vat_payer', type: 'boolean', value: String(d.is_vat_payer) },
      { ownerId: customerId, namespace: 'custom', key: 'address_street', type: 'single_line_text_field', value: d.address_street },
      { ownerId: customerId, namespace: 'custom', key: 'address_city', type: 'single_line_text_field', value: d.address_city },
      { ownerId: customerId, namespace: 'custom', key: 'address_zip', type: 'single_line_text_field', value: d.address_zip },
      { ownerId: customerId, namespace: 'custom', key: 'expected_volume', type: 'single_line_text_field', value: d.expected_volume },
      { ownerId: customerId, namespace: 'custom', key: 'application_note', type: 'multi_line_text_field', value: d.note },
      { ownerId: customerId, namespace: 'custom', key: 'applied_at', type: 'date_time', value: new Date().toISOString() },
      { ownerId: customerId, namespace: 'custom', key: 'approval_token_used', type: 'boolean', value: 'false' },
    ]

    await shopifyGraphQL(METAFIELDS_SET, { metafields })
  } catch (err) {
    console.error('[submit] metafieldsSet error', err)
    // Non-fatal — pokračujeme, data jsou v customeru
  }

  // Generate approval token and send admin email
  const token = signToken(customerId, d.email)
  const approveLink = `${APP_URL}/api/b2b/approve?token=${encodeURIComponent(token)}`
  const rejectLink = `${APP_URL}/api/b2b/reject?token=${encodeURIComponent(token)}`

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

  console.log(`[submit] new B2B application customerId=${customerId} ico=${d.ico}`)
  return NextResponse.json({ ok: true, message: 'Žádost přijata' })
}
