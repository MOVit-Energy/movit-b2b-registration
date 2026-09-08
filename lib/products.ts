import { shopifyGraphQL, setMetafields } from './shopify'
import type { MetafieldInput } from './shopify'

const LOOKBACK_DAYS = Number(process.env.BESTSELLER_LOOKBACK_DAYS || 90)

interface LineItemNode {
  quantity: number
  product: { id: string } | null
}

interface OrdersPage {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    edges: {
      node: {
        id: string
        lineItems: { edges: { node: LineItemNode }[] }
      }
    }[]
  }
}

const ORDERS_FOR_BESTSELLERS_QUERY = `
  query OrdersForBestsellers($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          lineItems(first: 250) {
            edges {
              node {
                quantity
                product { id }
              }
            }
          }
        }
      }
    }
  }
`

// Sečte prodané kusy za posledních LOOKBACK_DAYS dní podle položek objednávek
// (ne podle Shopify reporting API — to vyžaduje samostatná analytics oprávnění
// a je omezené na fixní reportovací okna). Zrušené objednávky se nepočítají.
async function aggregateSalesByProduct(): Promise<Map<string, number>> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const searchQuery = `created_at:>=${since} AND cancelled:false`

  const sales = new Map<string, number>()
  let cursor: string | null = null

  do {
    const data: OrdersPage = await shopifyGraphQL<OrdersPage>(ORDERS_FOR_BESTSELLERS_QUERY, {
      first: 250,
      after: cursor,
      query: searchQuery,
    })

    for (const { node: order } of data.orders.edges) {
      for (const { node: item } of order.lineItems.edges) {
        if (!item.product) continue
        sales.set(item.product.id, (sales.get(item.product.id) ?? 0) + item.quantity)
      }
    }

    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null
  } while (cursor)

  return sales
}

export interface SyncBestsellersResult {
  productsRanked: number
}

// Spočítá prodejnost produktů za posledních LOOKBACK_DAYS dní a uloží pořadí
// (1 = nejprodávanější) do custom.bestseller_rank_90d. Produkty bez prodeje
// v tomto okně metafield vůbec nedostanou — při řazení e-mailu se berou jako
// nejméně prioritní (viz lib/followup.ts).
export async function syncBestsellerRanks(): Promise<SyncBestsellersResult> {
  const sales = await aggregateSalesByProduct()

  const ranked = [...sales.entries()].sort((a, b) => b[1] - a[1])

  const metafields: MetafieldInput[] = ranked.map(([productId], index) => ({
    ownerId: productId,
    namespace: 'custom',
    key: 'bestseller_rank_90d',
    type: 'number_integer',
    value: String(index + 1),
  }))

  await setMetafields(metafields, '[sync-bestsellers]')

  return { productsRanked: metafields.length }
}
