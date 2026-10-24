import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { shopifyGraphQL, findCustomerByEmail } from '@/lib/shopify'
import { checkRateLimit } from '@/lib/rateLimit'
import { issueQuizDiscount, type QuizDiscount } from '@/lib/smartQuiz'

// Lead z chytrého dotazníku na e-shopu (theme: assets/smart-quiz.js). Zákazník se
// založí vždy — s marketingovým souhlasem jen tehdy, když ho v dotazníku aktivně
// zaškrtl. Nativní storefront formulář tohle neumí (zakládá zákazníka vždy jako
// přihlášeného k newsletteru), proto přes Admin API.
//
// Když dotazník pošle i doporučené produkty, vytvoří se uživateli unikátní slevový
// kód (lib/smartQuiz.ts), vrátí se v odpovědi a přes Klaviyo se pošle e-mailem.

const TAG = 'smart-quiz'

const productId = z.string().regex(/^\d+$/)

const schema = z.object({
  email: z.string().email(),
  consent: z.boolean(),
  products: z
    .object({
      main: z.array(productId).max(4),
      areas: z.array(z.object({ label: z.string().max(100), ids: z.array(productId).max(4) })).max(3),
    })
    .optional(),
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

async function maybeIssueDiscount(
  customerId: string,
  email: string,
  products: z.infer<typeof schema>['products']
): Promise<QuizDiscount | null> {
  if (!products || products.main.length + products.areas.reduce((n, a) => n + a.ids.length, 0) < 2) return null
  try {
    return await issueQuizDiscount(customerId, email, products)
  } catch (err) {
    // Bez kódu se výsledky dotazníku zobrazí i tak, jen bez slevy.
    console.error('[smart-quiz] discount error', err)
    return null
  }
}

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
  const { consent, products } = parsed.data

  try {
    const existing = await findCustomerByEmail(email)

    if (!existing) {
      const { customerCreate } = await shopifyGraphQL<{
        customerCreate: UserErrors & { customer: { id: string } | null }
      }>(CUSTOMER_CREATE, {
        input: {
          email,
          tags: [TAG],
          ...(consent ? { emailMarketingConsent: subscribedConsent() } : {}),
        },
      })
      if (customerCreate.userErrors.length > 0 || !customerCreate.customer) {
        throw new Error(`customerCreate errors: ${JSON.stringify(customerCreate.userErrors)}`)
      }
      const discount = await maybeIssueDiscount(customerCreate.customer.id, email, products)
      return NextResponse.json({ ok: true, state: 'created', discount })
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
    const discount = await maybeIssueDiscount(existing.id, email, products)
    return NextResponse.json({ ok: true, state: 'existing', discount })
  } catch (err) {
    console.error('[smart-quiz] lead error', err)
    return NextResponse.json({ error: 'Nepodařilo se uložit e-mail' }, { status: 502 })
  }
}
