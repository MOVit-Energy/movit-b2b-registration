import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { shopifyGraphQL, findCustomerByEmail } from '@/lib/shopify'
import { checkRateLimit } from '@/lib/rateLimit'

// Lead z chytrého dotazníku na e-shopu (theme: assets/smart-quiz.js). Zákazník se
// založí vždy — s marketingovým souhlasem jen tehdy, když ho v dotazníku aktivně
// zaškrtl. Nativní storefront formulář tohle neumí (zakládá zákazníka vždy jako
// přihlášeného k newsletteru), proto přes Admin API.

const TAG = 'smart-quiz'

const schema = z.object({
  email: z.string().email(),
  consent: z.boolean(),
})

const CUSTOMER_CREATE = `
  mutation customerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`

const TAGS_ADD = `
  mutation tagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`

const CONSENT_UPDATE = `
  mutation consentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) {
      userErrors { field message }
    }
  }
`

function subscribedConsent() {
  return {
    marketingState: 'SUBSCRIBED',
    marketingOptInLevel: 'SINGLE_OPT_IN',
    consentUpdatedAt: new Date().toISOString(),
  }
}

type UserErrors = { userErrors: { field: string[] | null; message: string }[] }

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
  if (!checkRateLimit(`smart-quiz:${ip}`, 20)) {
    return NextResponse.json({ error: 'Příliš mnoho požadavků.' }, { status: 429 })
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

  const email = parsed.data.email.trim().toLowerCase()
  const { consent } = parsed.data

  try {
    const existing = await findCustomerByEmail(email)

    if (!existing) {
      const { customerCreate } = await shopifyGraphQL<{ customerCreate: UserErrors }>(CUSTOMER_CREATE, {
        input: {
          email,
          tags: [TAG],
          ...(consent ? { emailMarketingConsent: subscribedConsent() } : {}),
        },
      })
      if (customerCreate.userErrors.length > 0) {
        throw new Error(`customerCreate errors: ${JSON.stringify(customerCreate.userErrors)}`)
      }
      return NextResponse.json({ ok: true, state: 'created' })
    }

    // Existující zákazník: jen doplníme tag a případně souhlas. Bez zaškrtnutí
    // souhlasu jeho dosavadní marketingový stav neměníme (neodhlašujeme ho).
    const { tagsAdd } = await shopifyGraphQL<{ tagsAdd: UserErrors }>(TAGS_ADD, { id: existing.id, tags: [TAG] })
    if (tagsAdd.userErrors.length > 0) {
      console.error('[smart-quiz] tagsAdd userErrors', tagsAdd.userErrors)
    }
    if (consent) {
      const { customerEmailMarketingConsentUpdate } = await shopifyGraphQL<{
        customerEmailMarketingConsentUpdate: UserErrors
      }>(CONSENT_UPDATE, {
        input: { customerId: existing.id, emailMarketingConsent: subscribedConsent() },
      })
      if (customerEmailMarketingConsentUpdate.userErrors.length > 0) {
        throw new Error(`consentUpdate errors: ${JSON.stringify(customerEmailMarketingConsentUpdate.userErrors)}`)
      }
    }
    return NextResponse.json({ ok: true, state: 'existing' })
  } catch (err) {
    console.error('[smart-quiz] lead error', err)
    return NextResponse.json({ error: 'Nepodařilo se uložit e-mail' }, { status: 502 })
  }
}
