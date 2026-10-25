import { randomInt } from 'crypto'
import { shopifyGraphQL, shopifyDiscountsGraphQL, setMetafields } from './shopify'
import { trackEvent } from './klaviyo'
import { pragueLocalToUtc, todayInPrague, formatCzDate, formatPrice } from './replenishment'

// Slevový kód z chytrého dotazníku (theme: assets/smart-quiz.js). Každý uživatel
// dostane vlastní jednorázový kód s platností DISCOUNT_VALID_DAYS. Kód je app
// discount nad funkcí smart-quiz-discount (repo movit-extensions); seznam produktů,
// které dotazník uživateli doporučil, nese metafield slevy a funkce podle počtu
// různých doporučených produktů v košíku dá slevu dle DISCOUNT_TIERS.

const DISCOUNT_VALID_DAYS = 7
// Musí sedět s DISCOUNT_TIERS v theme (assets/smart-quiz-data.js).
export const DISCOUNT_TIERS = [
  { count: 2, percent: 5 },
  { count: 3, percent: 10 },
  { count: 4, percent: 15 },
]
const FUNCTION_HANDLE = 'smart-quiz-discount'
const CONFIG_NAMESPACE = '$app'
const CONFIG_KEY = 'smart-quiz-config'
// Tag na každém vygenerovaném kódu — v adminu (Discounts) jde podle něj tyhle
// automatické kódy odfiltrovat, stejně jako u docházejícího balení.
const DISCOUNT_TAG = 'auto-smart-quiz'
const CODE_PREFIX = 'QUIZ-'
// Bez snadno zaměnitelných znaků (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const SHOP_URL = (process.env.SHOP_URL || '').replace(/\/+$/, '')
const METRIC = 'Smart Quiz Completed'
// Poslední kód zákazníka — při dalším vyplnění dotazníku ho deaktivujeme, ať má
// každý uživatel vždy jen jeden platný kód.
const CUSTOMER_METAFIELD = { namespace: 'custom', key: 'smart_quiz_discount' }

export interface QuizProducts {
  main: string[]
  areas: { label: string; ids: string[] }[]
}

export interface QuizDiscount {
  code: string
  expiresAt: string
  expiresLabel: string
}

const toGid = (id: string) => `gid://shopify/Product/${id}`

function generateCode(): string {
  let out = CODE_PREFIX
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}

function computeExpiresAt(): Date {
  const { y, m, d } = todayInPrague()
  return pragueLocalToUtc(y, m, d + DISCOUNT_VALID_DAYS, 23, 59, 59)
}

// ── Sleva ────────────────────────────────────────────────────────────────────

const DISCOUNT_CREATE = `
  mutation discountCodeAppCreate($codeAppDiscount: DiscountCodeAppInput!) {
    discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
      codeAppDiscount { discountId }
      userErrors { field message code }
    }
  }
`

const DISCOUNT_DEACTIVATE = `
  mutation discountCodeDeactivate($id: ID!) {
    discountCodeDeactivate(id: $id) {
      userErrors { field message }
    }
  }
`

type CreateResult = {
  discountCodeAppCreate: {
    codeAppDiscount: { discountId: string } | null
    userErrors: { field: string[] | null; message: string; code: string | null }[]
  }
}

async function createDiscount(productIds: string[], email: string): Promise<{ id: string; code: string; expiresAt: Date }> {
  const expiresAt = computeExpiresAt()
  // email funkce nepotřebuje — slouží jen pro detail slevy v adminu
  // (movit-extensions: smart-quiz-settings).
  const config = JSON.stringify({
    email,
    productIds: productIds.map(toGid),
    tiers: DISCOUNT_TIERS.map(t => ({ count: t.count, percent: t.percent })),
  })

  // Kolize náhodného kódu je krajně nepravděpodobná, ale Shopify ji vrací jako
  // userError — v tom případě zkusíme jiný kód.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateCode()
    const { discountCodeAppCreate: res } = await shopifyDiscountsGraphQL<CreateResult>(DISCOUNT_CREATE, {
      codeAppDiscount: {
        title: `Chytrý dotazník – ${code}`,
        functionHandle: FUNCTION_HANDLE,
        code,
        startsAt: new Date().toISOString(),
        endsAt: expiresAt.toISOString(),
        context: { all: 'ALL' },
        usageLimit: 1,
        appliesOncePerCustomer: false,
        discountClasses: ['PRODUCT'],
        combinesWith: { productDiscounts: true, orderDiscounts: true, shippingDiscounts: true },
        tags: [DISCOUNT_TAG],
        metafields: [{ namespace: CONFIG_NAMESPACE, key: CONFIG_KEY, type: 'json', value: config }],
      },
    })
    if (res.codeAppDiscount && res.userErrors.length === 0) {
      return { id: res.codeAppDiscount.discountId, code, expiresAt }
    }
    const taken = res.userErrors.some(e => e.code === 'TAKEN' || /already|taken|unique/i.test(e.message))
    if (!taken) throw new Error(`discountCodeAppCreate selhalo: ${JSON.stringify(res.userErrors)}`)
  }
  throw new Error('discountCodeAppCreate: nepodařilo se vygenerovat unikátní kód')
}

const CUSTOMER_DISCOUNT_QUERY = `
  query customerQuizDiscount($id: ID!) {
    customer(id: $id) {
      metafield(namespace: "${CUSTOMER_METAFIELD.namespace}", key: "${CUSTOMER_METAFIELD.key}") { value }
    }
  }
`

async function deactivatePreviousDiscount(customerId: string): Promise<void> {
  const { customer } = await shopifyGraphQL<{ customer: { metafield: { value: string } | null } | null }>(
    CUSTOMER_DISCOUNT_QUERY,
    { id: customerId }
  )
  let previous: { id?: string; expiresAt?: string } = {}
  try {
    previous = JSON.parse(customer?.metafield?.value ?? '{}')
  } catch {
    return
  }
  if (!previous.id || !previous.expiresAt || new Date(previous.expiresAt) < new Date()) return

  const { discountCodeDeactivate } = await shopifyDiscountsGraphQL<{
    discountCodeDeactivate: { userErrors: { field: string[] | null; message: string }[] }
  }>(DISCOUNT_DEACTIVATE, { id: previous.id })
  if (discountCodeDeactivate.userErrors.length > 0) {
    console.error('[smart-quiz] discountCodeDeactivate userErrors', discountCodeDeactivate.userErrors)
  }
}

// ── Produkty pro e-mail ──────────────────────────────────────────────────────

interface EmailProduct {
  name: string
  image_url: string
  url: string
  price: string
}

const PRODUCTS_QUERY = `
  query quizProducts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
        status
        featuredImage { url }
        priceRangeV2 { minVariantPrice { amount } }
      }
    }
  }
`

type ProductNode = {
  id: string
  title: string
  handle: string
  status: string
  featuredImage: { url: string } | null
  priceRangeV2: { minVariantPrice: { amount: string } } | null
} | null

async function fetchEmailProducts(ids: string[]): Promise<Map<string, EmailProduct>> {
  const { nodes } = await shopifyGraphQL<{ nodes: ProductNode[] }>(PRODUCTS_QUERY, { ids: ids.map(toGid) })
  const out = new Map<string, EmailProduct>()
  for (const p of nodes) {
    if (!p || p.status !== 'ACTIVE') continue
    out.set(p.id.split('/').pop()!, {
      name: p.title,
      image_url: p.featuredImage?.url ?? '',
      url: `${SHOP_URL}/products/${p.handle}`,
      price: p.priceRangeV2 ? formatPrice(p.priceRangeV2.minVariantPrice.amount) : '',
    })
  }
  return out
}

// ── Hlavní běh ───────────────────────────────────────────────────────────────

/**
 * Vytvoří zákazníkovi nový slevový kód na doporučené produkty (předchozí
 * deaktivuje), uloží ho k zákazníkovi a pošle do Klaviyo event, na který je
 * navázaný transakční e-mail s výsledky dotazníku a kódem.
 */
export async function issueQuizDiscount(
  customerId: string,
  email: string,
  products: QuizProducts
): Promise<QuizDiscount> {
  const allIds = [...new Set([...products.main, ...products.areas.flatMap(a => a.ids)])]

  await deactivatePreviousDiscount(customerId).catch(err =>
    console.error('[smart-quiz] deactivate previous discount failed', err)
  )

  const discount = await createDiscount(allIds, email)
  const expiresLabel = formatCzDate(discount.expiresAt)

  await setMetafields(
    [
      {
        ownerId: customerId,
        namespace: CUSTOMER_METAFIELD.namespace,
        key: CUSTOMER_METAFIELD.key,
        type: 'json',
        value: JSON.stringify({ id: discount.id, code: discount.code, expiresAt: discount.expiresAt.toISOString() }),
      },
    ],
    '[smart-quiz]'
  )

  // E-mail je jen doplněk výsledků — kód už uživatel vidí na stránce, takže
  // selhání Klaviyo jen zalogujeme.
  try {
    const productMap = await fetchEmailProducts(allIds)
    const pick = (ids: string[]) => ids.map(id => productMap.get(id)).filter((p): p is EmailProduct => !!p)
    await trackEvent(
      METRIC,
      { email },
      {
        discount_code: discount.code,
        discount_expires_at: expiresLabel,
        discount_valid_days: DISCOUNT_VALID_DAYS,
        discount_tiers: DISCOUNT_TIERS,
        // Odkaz, který kód rovnou vloží do košíku a přesměruje na e-shop.
        discount_url: `${SHOP_URL}/discount/${encodeURIComponent(discount.code)}`,
        main_products: pick(products.main),
        areas: products.areas
          .map(a => ({ label: a.label, products: pick(a.ids) }))
          .filter(a => a.products.length > 0),
      }
    )
  } catch (err) {
    console.error('[smart-quiz] Klaviyo event failed', err)
  }

  return { code: discount.code, expiresAt: discount.expiresAt.toISOString(), expiresLabel }
}
