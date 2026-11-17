import { shopifyGraphQL, setMetafields, addTags } from './shopify'
import { trackEvent } from './klaviyo'

const ORDER_LOOKBACK_DAYS = Number(process.env.ORDER_LOOKBACK_DAYS || 30)
const FOLLOWUP_DELAY_HOURS = Number(process.env.FOLLOWUP_DELAY_HOURS || 24)
const MAX_PRODUCTS = 5
const MAX_ARTICLES = 3
const SHOP_URL = (process.env.SHOP_URL || '').replace(/\/+$/, '')
const KLAVIYO_METRIC = 'Order Product Followup'
// Tag na objednávce vedle followup_email_sent_at metafieldu — Shopify order
// search neumí filtrovat podle metafieldu, ale podle tagu ano.
const ORDER_TAG = 'order-followup-sent'

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
            events(first: 20, sortKey: HAPPENED_AT) {
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
  articles: { references: { nodes: Partial<ArticleNode>[] } | null } | null
}

interface ArticleNode {
  id: string
  title: string
  handle: string
  isPublished: boolean
  summary: string | null
  body: string | null
  image: { url: string } | null
  blog: { handle: string } | null
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
      articles: metafield(namespace: "custom", key: "email_articles") {
        references(first: 50) {
          nodes {
            ... on Article {
              id
              title
              handle
              isPublished
              summary
              body
              image { url }
              blog { handle }
            }
          }
        }
      }
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

interface EmailArticle {
  id: string
  title: string
  url: string
  image_url: string
  excerpt: string
}

interface ProductData {
  // null = produkt nemá e-mailová data (podnadpis), do produktové části se nedostane
  product: EmailProduct | null
  rank: number
  // Články se berou i z produktů bez e-mailových dat — jsou to dvě nezávislé sekce.
  articles: EmailArticle[]
}

async function fetchProductData(productId: string): Promise<ProductData | null> {
  const { product } = await shopifyGraphQL<{ product: ProductNode | null }>(PRODUCT_EMAIL_DATA_QUERY, {
    id: productId,
  })
  if (!product) return null

  const rank = product.bestsellerRank?.value ? parseInt(product.bestsellerRank.value, 10) : Infinity
  return {
    product: toEmailProduct(product),
    rank: Number.isFinite(rank) ? rank : Infinity,
    articles: toEmailArticles(product),
  }
}

// "musí na ně být data v Shopify" — bez podnadpisu produkt do e-mailu nezahrnujeme.
function toEmailProduct(product: ProductNode): EmailProduct | null {
  const productId = product.id
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

  return emailProduct
}

// ── Articles ─────────────────────────────────────────────────────────────────

function toEmailArticles(product: ProductNode): EmailArticle[] {
  const nodes = product.articles?.references?.nodes ?? []
  const articles: EmailArticle[] = []
  for (const ref of nodes) {
    // Reference mimo Article (nemělo by nastat) přijde jako prázdný objekt.
    if (!ref.id) continue
    const node = ref as ArticleNode
    if (!node.isPublished || !node.blog) continue
    const excerpt = articleExcerpt(node)
    if (!node.image?.url || !excerpt) {
      // Bez obrázku nebo textu by blok v e-mailu vypadal rozbitě — radši článek vynecháme.
      console.warn(`[followup] article ${node.id} skipped (missing image or text)`)
      continue
    }
    articles.push({
      id: node.id,
      title: node.title,
      url: `${SHOP_URL}/blogs/${node.blog.handle}/${node.handle}`,
      image_url: croppedImageUrl(node.image.url, ARTICLE_IMAGE_WIDTH, ARTICLE_IMAGE_HEIGHT),
      excerpt,
    })
  }
  return articles
}

// Obrázek v e-mailu má pevný poměr stran, aby box vypadal u všech článků stejně.
// Shopify CDN umí ořez přes query parametry (2× kvůli retina displejům).
const ARTICLE_IMAGE_WIDTH = 480
const ARTICLE_IMAGE_HEIGHT = 480

function croppedImageUrl(url: string, width: number, height: number): string {
  try {
    const u = new URL(url)
    u.searchParams.set('width', String(width))
    u.searchParams.set('height', String(height))
    u.searchParams.set('crop', 'center')
    return u.toString()
  } catch {
    return url
  }
}

const EXCERPT_MAX_LENGTH = 220

// "Nadpis, obrázek, první větu brát z toho, jak máme nastavené Shopify":
// primárně úryvek (summary) článku, jinak první věta z těla článku.
function articleExcerpt(article: ArticleNode): string {
  const summary = htmlToText(article.summary ?? '')
  if (summary) return summary.length <= EXCERPT_MAX_LENGTH ? summary : firstSentence(summary)
  // Z těla bereme první neprázdný odstavec, ať se k větě nepřilepí nadpis sekce.
  const body = article.body ?? ''
  const firstParagraph = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => htmlToText(m[1]))
    .find(text => text.length > 0)
  return firstSentence(firstParagraph ?? htmlToText(body))
}

function firstSentence(text: string): string {
  const match = text.match(/^.+?[.!?…](?=\s|$)/)
  const sentence = match ? match[0] : text
  if (sentence.length <= EXCERPT_MAX_LENGTH) return sentence
  const cut = sentence.slice(0, EXCERPT_MAX_LENGTH)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:–-]+$/, '') + '…'
}

function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/h\d|\/li)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/**
 * Náhodný výběr článků s důrazem na pestrost: bereme po jednom článku z každého
 * produktu (produkty i jejich články v náhodném pořadí), dokud nemáme MAX_ARTICLES.
 * Má-li objednávka jen jeden produkt, vybereme víc článků od něj. Jeden článek může
 * být přiřazený více produktům, v e-mailu ale smí být jen jednou.
 */
export function pickArticles(articlesPerProduct: EmailArticle[][], max = MAX_ARTICLES): EmailArticle[] {
  const queues = shuffle(articlesPerProduct.filter(list => list.length > 0)).map(list => shuffle(list))
  const picked: EmailArticle[] = []
  const usedIds = new Set<string>()

  while (picked.length < max && queues.some(q => q.length > 0)) {
    for (const queue of queues) {
      if (picked.length >= max) break
      while (queue.length > 0) {
        const article = queue.shift()!
        if (usedIds.has(article.id)) continue
        usedIds.add(article.id)
        picked.push(article)
        break
      }
    }
  }
  return picked
}

async function buildEmailContent(order: OrderNode): Promise<{ products: EmailProduct[]; articles: EmailArticle[] }> {
  const productIds = [...new Set(order.lineItems.edges.map(e => e.node.product?.id).filter((id): id is string => !!id))]

  const results = (await Promise.all(productIds.map(id => fetchProductData(id)))).filter(
    (r): r is ProductData => r !== null
  )

  const products = results
    .filter((r): r is ProductData & { product: EmailProduct } => r.product !== null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, MAX_PRODUCTS)
    .map(r => r.product)

  const articles = pickArticles(results.map(r => r.articles))

  return { products, articles }
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
  await addTags(orderId, [ORDER_TAG], '[followup]')
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

        const { products, articles } = await buildEmailContent(order)
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
          // id článku je jen interní pro deduplikaci, do šablony ho neposíláme
          { order_name: order.name, products, articles: articles.map(({ id: _id, ...article }) => article) }
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
