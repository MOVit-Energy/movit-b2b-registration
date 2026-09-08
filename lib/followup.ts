import { shopifyGraphQL, setMetafields } from './shopify'
import { trackEvent } from './klaviyo'

const ORDER_LOOKBACK_DAYS = Number(process.env.ORDER_LOOKBACK_DAYS || 30)
const FOLLOWUP_DELAY_HOURS = Number(process.env.FOLLOWUP_DELAY_HOURS || 24)
const MAX_PRODUCTS = 5
const SHOP_URL = (process.env.SHOP_URL || '').replace(/\/+$/, '')
const KLAVIYO_METRIC = 'Order Product Followup'

// Testovací režim: když je nastaveno, VŠECHNY followup e-maily se přesměrují na
// tuto adresu místo skutečného zákazníka (objednávka se přesto vyhodnocuje a
// označuje jako odeslaná normálně). Před ostrým provozem v Vercel env vars smazat.
const TEST_EMAIL_OVERRIDE = process.env.FOLLOWUP_TEST_EMAIL_OVERRIDE?.trim() || null

// ── Shopify types ────────────────────────────────────────────────────────────

interface FulfillmentEvent {
  status: string
  happenedAt: string
}

interface Fulfillment {
  displayStatus: string
  events: { edges: { node: FulfillmentEvent }[] }
}

interface OrderNode {
  id: string
  name: string
  customer: { email: string | null; firstName: string | null } | null
  fulfillments: Fulfillment[]
  followupSent: { value: string } | null
  lineItems: { edges: { node: { product: { id: string } | null } }[] }
}

interface OrdersPage {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    edges: { node: OrderNode }[]
  }
}

const CANDIDATE_ORDERS_QUERY = `
  query CandidateOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          customer { email firstName }
          followupSent: metafield(namespace: "custom", key: "followup_email_sent_at") { value }
          fulfillments(first: 10) {
            displayStatus
            events(first: 20, sortKey: CREATED_AT) {
              edges { node { status happenedAt } }
            }
          }
          lineItems(first: 250) {
            edges { node { product { id } } }
          }
        }
      }
    }
  }
`

interface ProductNode {
  id: string
  title: string
  handle: string
  featuredImage: { url: string } | null
  subtitle: { value: string } | null
  bullets: { value: string } | null
  usageNote: { value: string } | null
  reviewImageUrl: { value: string } | null
  bestsellerRank: { value: string } | null
}

const PRODUCT_EMAIL_DATA_QUERY = `
  query ProductEmailData($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      featuredImage { url }
      subtitle: metafield(namespace: "custom", key: "email_subtitle") { value }
      bullets: metafield(namespace: "custom", key: "email_bullets") { value }
      usageNote: metafield(namespace: "custom", key: "email_usage_note") { value }
      reviewImageUrl: metafield(namespace: "custom", key: "email_review_image_url") { value }
      bestsellerRank: metafield(namespace: "custom", key: "bestseller_rank_90d") { value }
    }
  }
`

// ── Eligibility ──────────────────────────────────────────────────────────────

function findDeliveredAt(order: OrderNode): Date | null {
  let latest: Date | null = null
  for (const fulfillment of order.fulfillments) {
    if (fulfillment.displayStatus !== 'DELIVERED') continue
    for (const { node: event } of fulfillment.events.edges) {
      if (event.status !== 'DELIVERED') continue
      const happenedAt = new Date(event.happenedAt)
      if (!latest || happenedAt > latest) latest = happenedAt
    }
  }
  return latest
}

interface EmailBullet {
  title: string
  text: string
}

interface EmailProduct {
  name: string
  image_url: string
  url: string
  subtitle: string
  bullets: EmailBullet[]
  usage_note?: string
  review_image_url?: string
}

// "musí na ně být data v Shopify" — bez podnadpisu produkt do e-mailu nezahrnujeme.
async function fetchEligibleProduct(productId: string): Promise<{ product: EmailProduct; rank: number } | null> {
  const { product } = await shopifyGraphQL<{ product: ProductNode | null }>(PRODUCT_EMAIL_DATA_QUERY, {
    id: productId,
  })
  if (!product) return null

  const subtitle = product.subtitle?.value?.trim()
  if (!subtitle) return null

  let bullets: EmailBullet[] = []
  if (product.bullets?.value) {
    try {
      const parsed = JSON.parse(product.bullets.value)
      if (Array.isArray(parsed)) {
        bullets = parsed
          .filter((b): b is EmailBullet => typeof b?.title === 'string' && typeof b?.text === 'string')
          .map(b => ({ title: b.title, text: b.text }))
      }
    } catch (err) {
      console.error(`[followup] invalid email_bullets JSON on product=${productId}`, err)
    }
  }

  const rank = product.bestsellerRank?.value ? parseInt(product.bestsellerRank.value, 10) : Infinity

  const emailProduct: EmailProduct = {
    name: product.title,
    image_url: product.featuredImage?.url ?? '',
    url: `${SHOP_URL}/products/${product.handle}`,
    subtitle,
    bullets,
  }
  const usageNote = product.usageNote?.value?.trim()
  if (usageNote) emailProduct.usage_note = usageNote
  const reviewImageUrl = product.reviewImageUrl?.value?.trim()
  if (reviewImageUrl) emailProduct.review_image_url = reviewImageUrl

  return { product: emailProduct, rank: Number.isFinite(rank) ? rank : Infinity }
}

async function buildEmailProducts(order: OrderNode): Promise<EmailProduct[]> {
  const productIds = [...new Set(order.lineItems.edges.map(e => e.node.product?.id).filter((id): id is string => !!id))]

  const results = await Promise.all(productIds.map(id => fetchEligibleProduct(id)))
  const eligible = results.filter((r): r is { product: EmailProduct; rank: number } => r !== null)

  eligible.sort((a, b) => a.rank - b.rank)

  return eligible.slice(0, MAX_PRODUCTS).map(r => r.product)
}

async function markSent(orderId: string): Promise<void> {
  await setMetafields(
    [
      {
        ownerId: orderId,
        namespace: 'custom',
        key: 'followup_email_sent_at',
        type: 'date_time',
        value: new Date().toISOString(),
      },
    ],
    '[followup]'
  )
}

export interface SendFollowupsResult {
  scanned: number
  sent: number
  skippedNoProducts: number
  errors: number
}

export async function sendOrderFollowups(): Promise<SendFollowupsResult> {
  if (TEST_EMAIL_OVERRIDE) {
    console.warn(`[followup] TEST MODE — all emails redirected to ${TEST_EMAIL_OVERRIDE}`)
  }

  const since = new Date(Date.now() - ORDER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const searchQuery = `fulfillment_status:fulfilled AND updated_at:>=${since}`

  const result: SendFollowupsResult = { scanned: 0, sent: 0, skippedNoProducts: 0, errors: 0 }
  let cursor: string | null = null

  do {
    const data: OrdersPage = await shopifyGraphQL<OrdersPage>(CANDIDATE_ORDERS_QUERY, {
      first: 100,
      after: cursor,
      query: searchQuery,
    })

    for (const { node: order } of data.orders.edges) {
      result.scanned++
      try {
        if (order.followupSent?.value) continue
        if (!order.customer?.email) continue

        const deliveredAt = findDeliveredAt(order)
        if (!deliveredAt) continue

        const hoursSinceDelivery = (Date.now() - deliveredAt.getTime()) / (1000 * 60 * 60)
        if (hoursSinceDelivery < FOLLOWUP_DELAY_HOURS) continue

        const products = await buildEmailProducts(order)
        if (products.length === 0) {
          // Neposíláme, ale ani neoznačujeme jako vyřízené — metafieldy produktu
          // se ještě mohou v rámci lookback okna doplnit a e-mail by měl odejít pak.
          result.skippedNoProducts++
          continue
        }

        await trackEvent(
          KLAVIYO_METRIC,
          {
            email: TEST_EMAIL_OVERRIDE ?? order.customer.email,
            first_name: order.customer.firstName ?? undefined,
          },
          { order_name: order.name, products }
        )
        await markSent(order.id)
        result.sent++
      } catch (err) {
        result.errors++
        console.error(`[followup] error order=${order.id}`, err)
      }
    }

    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null
  } while (cursor)

  return result
}
