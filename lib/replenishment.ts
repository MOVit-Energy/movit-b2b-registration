import { shopifyGraphQL, setMetafields } from './shopify'
import { trackEvent } from './klaviyo'

const LOOKBACK_DAYS = Number(process.env.REPLENISHMENT_LOOKBACK_DAYS || 400)
const CUSTOMER_COOLDOWN_DAYS = 7
const DISCOUNT_VALID_DAYS = 3
const DISCOUNT_PERCENTAGE = 10
// Tag na každém vygenerovaném kódu — umožňuje si v Shopify adminu (Discounts →
// filtr/uložený pohled podle tagu) tyhle automaticky generované kódy schovat
// z výchozího přehledu, ať nezahlcují seznam ručně vytvářených akcí.
const DISCOUNT_TAG = 'auto-replenishment'
const SHOP_URL = (process.env.SHOP_URL || '').replace(/\/+$/, '')
const TIMEZONE = 'Europe/Prague'
const METRIC_REMINDER = 'Replenishment Reminder'
const METRIC_DISCOUNT = 'Replenishment Discount Reminder'

// Testovací režim: když je nastaveno, VŠECHNY e-maily se přesměrují na tuto
// adresu místo skutečného zákazníka (objednávky se přesto vyhodnocují a
// označují normálně). Před ostrým provozem v Vercel env vars smazat.
const TEST_EMAIL_OVERRIDE = process.env.REPLENISHMENT_TEST_EMAIL_OVERRIDE?.trim() || null

// ── Časové pásmo ─────────────────────────────────────────────────────────────
// Slevový kód musí platit přesně do 23:59:59 Europe/Prague, ne UTC — proto
// veškerá práce s "kterým dnem to je" jde přes Intl, ne přes new Date() v UTC.

function pragueOffsetMinutes(utcInstant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(utcInstant)
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return (asIfUtc - utcInstant.getTime()) / 60000
}

function pragueLocalToUtc(y: number, m: number, d: number, h: number, min: number, s: number): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min, s))
  const offsetMin = pragueOffsetMinutes(guess)
  return new Date(guess.getTime() - offsetMin * 60000)
}

function todayInPrague(): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day }
}

function formatCzDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]))
  return `${p.day}.${p.month}.${p.year}`
}

function computeDiscountExpiresAt(): Date {
  const { y, m, d } = todayInPrague()
  return pragueLocalToUtc(y, m, d + DISCOUNT_VALID_DAYS, 23, 59, 59)
}

// ── Délka spotřeby ───────────────────────────────────────────────────────────
// Stejná logika jako storefront používá pro zobrazení "vydrží X měsíců" na PDP
// (movitenergy/assets/product-package-selector.js:577-622) — jen navíc bereme
// střed rozsahu místo zobrazení celého rozsahu.

function parseDaysPerUnit(dosageRaw: string | null, packageSizeRaw: string | null): number | null {
  if (!dosageRaw || !packageSizeRaw) return null

  let dosageText: string | undefined
  let packageSizeText: string | undefined
  try {
    dosageText = JSON.parse(dosageRaw)[0]
    packageSizeText = JSON.parse(packageSizeRaw)[0]
  } catch {
    return null
  }
  if (!dosageText || !packageSizeText) return null

  const sizeMatch = packageSizeText.match(/^(\d+)/)
  if (!sizeMatch) return null
  const totalUnits = parseInt(sizeMatch[1], 10)
  if (!totalUnits) return null

  const dosageMatch = dosageText.match(/(\d+)(?:-(\d+))?x/)
  if (!dosageMatch) return null
  const minDosage = parseInt(dosageMatch[1], 10)
  const maxDosage = dosageMatch[2] ? parseInt(dosageMatch[2], 10) : minDosage
  if (!minDosage || !maxDosage) return null

  const daysAtMinDosage = totalUnits / minDosage // pomalejší spotřeba = delší výdrž
  const daysAtMaxDosage = totalUnits / maxDosage // rychlejší spotřeba = kratší výdrž
  return (daysAtMinDosage + daysAtMaxDosage) / 2
}

function formatPrice(amount: string): string {
  const num = Number(amount)
  if (!Number.isFinite(num)) return ''
  return `${num.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Kč`
}

function isGiftLineItem(item: { customAttributes: { key: string; value: string }[] }): boolean {
  return item.customAttributes.some(a => a.key === '_gift' || a.key === '_promo')
}

// ── Produkty (cachované v rámci jednoho běhu) ───────────────────────────────

interface ProductReplenishmentData {
  id: string
  title: string
  handle: string
  imageUrl: string
  price: string
  active: boolean
  inStock: boolean
  excluded: boolean
  daysPerUnit: number | null
}

interface ProductQueryResult {
  id: string
  title: string
  handle: string
  status: string
  totalInventory: number | null
  featuredImage: { url: string } | null
  priceRangeV2: { minVariantPrice: { amount: string } } | null
  dosage: { value: string } | null
  packageSize: { value: string } | null
  excludedMeta: { value: string } | null
}

const PRODUCT_QUERY = `
  query ProductReplenishmentData($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      totalInventory
      featuredImage { url }
      priceRangeV2 { minVariantPrice { amount } }
      dosage: metafield(namespace: "custom", key: "dosage") { value }
      packageSize: metafield(namespace: "custom", key: "package_size") { value }
      excludedMeta: metafield(namespace: "custom", key: "replenishment_excluded") { value }
    }
  }
`

const productCache = new Map<string, ProductReplenishmentData | null>()

async function getProductData(productId: string): Promise<ProductReplenishmentData | null> {
  if (productCache.has(productId)) return productCache.get(productId)!

  const { product } = await shopifyGraphQL<{ product: ProductQueryResult | null }>(PRODUCT_QUERY, { id: productId })
  if (!product) {
    productCache.set(productId, null)
    return null
  }

  const data: ProductReplenishmentData = {
    id: product.id,
    title: product.title,
    handle: product.handle,
    imageUrl: product.featuredImage?.url ?? '',
    price: product.priceRangeV2 ? formatPrice(product.priceRangeV2.minVariantPrice.amount) : '',
    active: product.status === 'ACTIVE',
    inStock: (product.totalInventory ?? 0) > 0,
    excluded: product.excludedMeta?.value === 'true',
    daysPerUnit: parseDaysPerUnit(product.dosage?.value ?? null, product.packageSize?.value ?? null),
  }
  productCache.set(productId, data)
  return data
}

// ── Stav objednávky ──────────────────────────────────────────────────────────

interface StatusEntry {
  product_id: string
  repurchased?: true
  email1_sent_at?: string
  email1_batch_id?: string
  email2_sent_at?: string
}

function parseStatus(raw: string | null): StatusEntry[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function mergeStatusEntries(existing: StatusEntry[], updates: StatusEntry[]): StatusEntry[] {
  const map = new Map(existing.map(e => [e.product_id, e]))
  for (const u of updates) map.set(u.product_id, { ...map.get(u.product_id), ...u })
  return [...map.values()]
}

// "not_sent" | "partial" | "sent" | "reminder_sent" — přesně ty 4 stavy, co
// popisuješ. "reminder_sent" (vše hotovo) zároveň slouží jako terminální stav.
function computeSummary(entries: StatusEntry[], eligibleProductIds: string[]): string {
  if (eligibleProductIds.length === 0) return 'not_sent'
  const byProduct = new Map(entries.map(e => [e.product_id, e]))

  let email1Count = 0
  let fullyResolvedCount = 0
  for (const id of eligibleProductIds) {
    const e = byProduct.get(id)
    if (!e) continue
    if (e.repurchased || e.email1_sent_at) email1Count++
    if (e.repurchased || e.email2_sent_at) fullyResolvedCount++
  }

  if (email1Count === 0) return 'not_sent'
  if (email1Count < eligibleProductIds.length) return 'partial'
  if (fullyResolvedCount < eligibleProductIds.length) return 'sent'
  return 'reminder_sent'
}

async function writeOrderStatus(orderId: string, entries: StatusEntry[], summary: string): Promise<void> {
  await setMetafields(
    [
      { ownerId: orderId, namespace: 'custom', key: 'replenishment_status', type: 'json', value: JSON.stringify(entries) },
      { ownerId: orderId, namespace: 'custom', key: 'replenishment_summary', type: 'single_line_text_field', value: summary },
    ],
    '[replenishment]'
  )
}

// ── Objednávky ke skenování ──────────────────────────────────────────────────

interface CustomerInfo {
  id: string
  email: string | null
  firstName: string | null
  lastBatchAt: string | null
}

interface LineItemNode {
  quantity: number
  product: { id: string } | null
  customAttributes: { key: string; value: string }[]
}

interface OrderNode {
  id: string
  name: string
  createdAt: string
  customer: CustomerInfo | null
  statusMeta: { value: string } | null
  lineItems: { edges: { node: LineItemNode }[] }
}

interface OrdersPage {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    edges: { node: OrderNode }[]
  }
}

const CANDIDATE_ORDERS_QUERY = `
  query CandidateOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          createdAt
          customer {
            id
            email
            firstName
            lastBatchAt: metafield(namespace: "custom", key: "replenishment_last_batch_at") { value }
          }
          statusMeta: metafield(namespace: "custom", key: "replenishment_status") { value }
          lineItems(first: 250) {
            edges {
              node {
                quantity
                product { id }
                customAttributes { key value }
              }
            }
          }
        }
      }
    }
  }
`

interface OrderContext {
  id: string
  createdAt: string
  customer: CustomerInfo
  eligibleProductIds: string[]
  statusEntries: StatusEntry[]
}

interface DueCandidate {
  orderId: string
  orderCreatedAt: string
  productId: string
  product: ProductReplenishmentData
}

async function buildOrderContext(order: OrderNode): Promise<{ ctx: OrderContext; dueCandidates: DueCandidate[] } | null> {
  if (!order.customer?.email) return null

  const statusEntries = parseStatus(order.statusMeta?.value ?? null)
  const byProduct = new Map(statusEntries.map(e => [e.product_id, e]))

  const quantityByProduct = new Map<string, number>()
  for (const { node: item } of order.lineItems.edges) {
    const productId = item.product?.id
    if (!productId || isGiftLineItem(item)) continue
    quantityByProduct.set(productId, (quantityByProduct.get(productId) ?? 0) + item.quantity)
  }

  const eligibleProductIds: string[] = []
  const dueCandidates: DueCandidate[] = []

  for (const [productId, quantity] of quantityByProduct) {
    const product = await getProductData(productId)
    if (!product || product.excluded || product.daysPerUnit == null) continue

    eligibleProductIds.push(productId)

    if (byProduct.has(productId)) continue // už vyřízeno (odesláno nebo dokoupeno)
    if (!product.active || !product.inStock) continue // dočasně neprodejné, zkusit příště

    const totalDays = product.daysPerUnit * quantity
    const dueAtMs = new Date(order.createdAt).getTime() + totalDays * 24 * 60 * 60 * 1000
    if (dueAtMs > Date.now()) continue // ještě nedochází

    dueCandidates.push({ orderId: order.id, orderCreatedAt: order.createdAt, productId, product })
  }

  return {
    ctx: { id: order.id, createdAt: order.createdAt, customer: order.customer, eligibleProductIds, statusEntries },
    dueCandidates,
  }
}

// ── Kontrola, že zákazník produkt nekoupil znovu ────────────────────────────

const CUSTOMER_ORDERS_QUERY = `
  query CustomerOrdersSince($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          createdAt
          lineItems(first: 250) {
            edges { node { product { id } customAttributes { key value } } }
          }
        }
      }
    }
  }
`

async function fetchLaterCustomerOrders(
  customerId: string,
  sinceIso: string
): Promise<{ createdAt: string; productIds: Set<string> }[]> {
  const numericId = customerId.split('/').pop()
  const searchQuery = `customer_id:${numericId} AND created_at:>${sinceIso}`
  const out: { createdAt: string; productIds: Set<string> }[] = []
  let cursor: string | null = null

  do {
    const data: OrdersPage = await shopifyGraphQL<OrdersPage>(CUSTOMER_ORDERS_QUERY, { first: 100, after: cursor, query: searchQuery })
    for (const { node } of data.orders.edges) {
      const productIds = new Set<string>()
      for (const { node: item } of node.lineItems.edges) {
        if (!item.product || isGiftLineItem(item)) continue
        productIds.add(item.product.id)
      }
      out.push({ createdAt: node.createdAt, productIds })
    }
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null
  } while (cursor)

  return out
}

// ── Slevový kód (jen pro email 2) ───────────────────────────────────────────

const DISCOUNT_CODE_CREATE = `
  mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message code }
    }
  }
`

async function createDiscountCode(productIds: string[]): Promise<{ code: string; expiresAt: Date }> {
  const code = `MOVIT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
  const expiresAt = computeDiscountExpiresAt()

  const result = await shopifyGraphQL<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null
      userErrors: { field: string[]; message: string; code: string }[]
    }
  }>(DISCOUNT_CODE_CREATE, {
    basicCodeDiscount: {
      title: `Docházející balení – ${code}`,
      code,
      startsAt: new Date().toISOString(),
      endsAt: expiresAt.toISOString(),
      customerSelection: { all: true },
      customerGets: {
        value: { percentage: DISCOUNT_PERCENTAGE / 100 },
        items: { products: { productsToAdd: productIds } },
      },
      appliesOncePerCustomer: false,
      usageLimit: 1,
      tags: [DISCOUNT_TAG],
    },
  })

  const errors = result.discountCodeBasicCreate.userErrors
  if (errors.length > 0 || !result.discountCodeBasicCreate.codeDiscountNode) {
    throw new Error(`discountCodeBasicCreate selhalo: ${JSON.stringify(errors)}`)
  }

  return { code, expiresAt }
}

// ── Hlavní běh ───────────────────────────────────────────────────────────────

export interface ReplenishmentResult {
  scanned: number
  email1Sent: number
  email2Sent: number
  errors: number
}

interface EmailProductRef {
  name: string
  image_url: string
  url: string
  price: string
}

function toEmailProduct(p: ProductReplenishmentData): EmailProductRef {
  return { name: p.title, image_url: p.imageUrl, url: `${SHOP_URL}/products/${p.handle}`, price: p.price }
}

async function processCustomerBatch(
  group: { customer: CustomerInfo; candidates: DueCandidate[] },
  orderContexts: Map<string, OrderContext>
): Promise<boolean> {
  const { customer, candidates } = group

  if (customer.lastBatchAt) {
    const cooldownMs = CUSTOMER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
    if (Date.now() - new Date(customer.lastBatchAt).getTime() < cooldownMs) {
      return false // ještě čekáme na uplynutí týdenního limitu, zkusí se příště
    }
  }

  const earliestOrderCreatedAt = candidates.reduce(
    (min, c) => (c.orderCreatedAt < min ? c.orderCreatedAt : min),
    candidates[0].orderCreatedAt
  )
  const laterOrders = await fetchLaterCustomerOrders(customer.id, earliestOrderCreatedAt)

  const confirmed: DueCandidate[] = []
  const writesByOrder = new Map<string, StatusEntry[]>()

  for (const c of candidates) {
    const wasRepurchased = laterOrders.some(
      lo => new Date(lo.createdAt).getTime() > new Date(c.orderCreatedAt).getTime() && lo.productIds.has(c.productId)
    )
    if (wasRepurchased) {
      const list = writesByOrder.get(c.orderId) ?? []
      list.push({ product_id: c.productId, repurchased: true })
      writesByOrder.set(c.orderId, list)
    } else {
      confirmed.push(c)
    }
  }

  let sent = false
  if (confirmed.length > 0) {
    const uniqueByProduct = new Map<string, DueCandidate>()
    for (const c of confirmed) if (!uniqueByProduct.has(c.productId)) uniqueByProduct.set(c.productId, c)

    const products = [...uniqueByProduct.values()].map(c => toEmailProduct(c.product))
    const batchId = new Date().toISOString()

    await trackEvent(
      METRIC_REMINDER,
      { email: TEST_EMAIL_OVERRIDE ?? customer.email!, first_name: customer.firstName ?? undefined },
      { products }
    )

    for (const c of confirmed) {
      const list = writesByOrder.get(c.orderId) ?? []
      list.push({ product_id: c.productId, email1_sent_at: new Date().toISOString(), email1_batch_id: batchId })
      writesByOrder.set(c.orderId, list)
    }

    await setMetafields(
      [
        {
          ownerId: customer.id,
          namespace: 'custom',
          key: 'replenishment_last_batch_at',
          type: 'date_time',
          value: new Date().toISOString(),
        },
      ],
      '[replenishment]'
    )
    sent = true
  }

  for (const [orderId, newEntries] of writesByOrder) {
    const ctx = orderContexts.get(orderId)
    if (!ctx) continue
    const merged = mergeStatusEntries(ctx.statusEntries, newEntries)
    await writeOrderStatus(orderId, merged, computeSummary(merged, ctx.eligibleProductIds))
    ctx.statusEntries = merged
  }

  return sent
}

async function sendDiscountFollowups(orderContexts: Map<string, OrderContext>): Promise<number> {
  const groups = new Map<string, { customer: CustomerInfo; items: { orderId: string; productId: string }[] }>()

  for (const ctx of orderContexts.values()) {
    for (const entry of ctx.statusEntries) {
      if (!entry.email1_sent_at || entry.email2_sent_at || entry.repurchased) continue
      const daysSince = (Date.now() - new Date(entry.email1_sent_at).getTime()) / (24 * 60 * 60 * 1000)
      if (daysSince < CUSTOMER_COOLDOWN_DAYS) continue

      const batchId = entry.email1_batch_id ?? `${ctx.customer.id}-unknown`
      if (!groups.has(batchId)) groups.set(batchId, { customer: ctx.customer, items: [] })
      groups.get(batchId)!.items.push({ orderId: ctx.id, productId: entry.product_id })
    }
  }

  let sentCount = 0
  for (const group of groups.values()) {
    try {
      const productDataList = await Promise.all(group.items.map(item => getProductData(item.productId)))
      const products = productDataList.filter((p): p is ProductReplenishmentData => p !== null)
      if (products.length === 0) continue

      const { code, expiresAt } = await createDiscountCode(products.map(p => p.id))

      await trackEvent(
        METRIC_DISCOUNT,
        { email: TEST_EMAIL_OVERRIDE ?? group.customer.email!, first_name: group.customer.firstName ?? undefined },
        {
          products: products.map(toEmailProduct),
          discount_code: code,
          discount_expires_at: formatCzDate(expiresAt),
        }
      )

      const byOrder = new Map<string, StatusEntry[]>()
      for (const item of group.items) {
        const list = byOrder.get(item.orderId) ?? []
        list.push({ product_id: item.productId, email2_sent_at: new Date().toISOString() })
        byOrder.set(item.orderId, list)
      }
      for (const [orderId, updates] of byOrder) {
        const ctx = orderContexts.get(orderId)
        if (!ctx) continue
        const merged = mergeStatusEntries(ctx.statusEntries, updates)
        await writeOrderStatus(orderId, merged, computeSummary(merged, ctx.eligibleProductIds))
        ctx.statusEntries = merged
      }

      sentCount++
    } catch (err) {
      console.error(`[replenishment] email2 error batch=${group.customer.id}`, err)
    }
  }

  return sentCount
}

export async function sendReplenishmentEmails(): Promise<ReplenishmentResult> {
  if (TEST_EMAIL_OVERRIDE) {
    console.warn(`[replenishment] TEST MODE — all emails redirected to ${TEST_EMAIL_OVERRIDE}`)
  }

  const result: ReplenishmentResult = { scanned: 0, email1Sent: 0, email2Sent: 0, errors: 0 }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const searchQuery = `created_at:>=${since}`

  const orderContexts = new Map<string, OrderContext>()
  const candidatesByCustomer = new Map<string, { customer: CustomerInfo; candidates: DueCandidate[] }>()

  let cursor: string | null = null
  do {
    const data: OrdersPage = await shopifyGraphQL<OrdersPage>(CANDIDATE_ORDERS_QUERY, { first: 100, after: cursor, query: searchQuery })

    for (const { node: order } of data.orders.edges) {
      result.scanned++
      try {
        const built = await buildOrderContext(order)
        if (!built) continue
        orderContexts.set(order.id, built.ctx)

        if (built.dueCandidates.length > 0) {
          const key = built.ctx.customer.id
          if (!candidatesByCustomer.has(key)) candidatesByCustomer.set(key, { customer: built.ctx.customer, candidates: [] })
          candidatesByCustomer.get(key)!.candidates.push(...built.dueCandidates)
        }
      } catch (err) {
        result.errors++
        console.error(`[replenishment] scan error order=${order.id}`, err)
      }
    }

    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null
  } while (cursor)

  for (const group of candidatesByCustomer.values()) {
    try {
      const sent = await processCustomerBatch(group, orderContexts)
      if (sent) result.email1Sent++
    } catch (err) {
      result.errors++
      console.error(`[replenishment] email1 error customer=${group.customer.id}`, err)
    }
  }

  result.email2Sent = await sendDiscountFollowups(orderContexts)

  return result
}
