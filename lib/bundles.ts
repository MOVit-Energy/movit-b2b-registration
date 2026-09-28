import { shopifyGraphQL, setMetafields } from './shopify'
import type { MetafieldInput } from './shopify'

// Propagace balíčků na detailu produktu (ESHO-119).
//
// Téma potřebuje ke každému produktu vědět, ve kterých balíčcích je, seřazené podle
// prodejnosti — to Liquid sám nespočítá (neumí projít komponenty Shopify Bundles ani
// objednávky). Cron proto zapisuje:
// - custom.bundles na komponentu: balíčky, které ji obsahují, od nejprodávanějšího
// - custom.bundle_components na balíček: jeho komponenty, aby téma mohlo ověřit
//   B2C sklad každé z nich (Shopify dostupnost balíčku počítá z celkového skladu,
//   ne z custom.stock_b2c)
//
// Dostupnost (sklad, vypnutí) se neukládá — téma ji kontroluje při vykreslení,
// týdenní přepočet by na ni byl pomalý.

const MAX_BUNDLES_PER_PRODUCT = 10

interface ProductNode {
  id: string
  status: string
  bundles: { value: string } | null
  bundleComponents: { value: string } | null
  variants: {
    nodes: {
      requiresComponents: boolean
      productVariantComponents: { nodes: { productVariant: { product: { id: string } } | null }[] }
    }[]
  }
}

interface ProductsPage {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: ProductNode[]
  }
}

const PRODUCTS_QUERY = `
  query ProductsForBundles($after: String) {
    products(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        status
        bundles: metafield(namespace: "custom", key: "bundles") { value }
        bundleComponents: metafield(namespace: "custom", key: "bundle_components") { value }
        variants(first: 20) {
          nodes {
            requiresComponents
            productVariantComponents(first: 30) {
              nodes { productVariant { product { id } } }
            }
          }
        }
      }
    }
  }
`

const METAFIELDS_DELETE = `
  mutation MetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      userErrors { field message }
    }
  }
`

async function fetchAllProducts(): Promise<ProductNode[]> {
  const products: ProductNode[] = []
  let cursor: string | null = null
  do {
    const data: ProductsPage = await shopifyGraphQL<ProductsPage>(PRODUCTS_QUERY, { after: cursor })
    products.push(...data.products.nodes)
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null
  } while (cursor)
  return products
}

function componentIds(product: ProductNode): string[] {
  const ids = new Set<string>()
  for (const variant of product.variants.nodes) {
    if (!variant.requiresComponents) continue
    for (const component of variant.productVariantComponents.nodes) {
      const id = component.productVariant?.product.id
      if (id && id !== product.id) ids.add(id)
    }
  }
  return [...ids]
}

function sameList(current: { value: string } | null, next: string[]): boolean {
  if (!current?.value) return next.length === 0
  try {
    return JSON.stringify(JSON.parse(current.value)) === JSON.stringify(next)
  } catch {
    return false
  }
}

async function deleteMetafields(ownerIds: string[], key: string, logPrefix: string): Promise<void> {
  for (let i = 0; i < ownerIds.length; i += 25) {
    const metafields = ownerIds.slice(i, i + 25).map((ownerId) => ({ ownerId, namespace: 'custom', key }))
    const { metafieldsDelete } = await shopifyGraphQL<{
      metafieldsDelete: { userErrors: { field: string[]; message: string }[] }
    }>(METAFIELDS_DELETE, { metafields })
    if (metafieldsDelete.userErrors.length > 0) {
      console.error(`${logPrefix} metafieldsDelete userErrors key=${key}`, metafieldsDelete.userErrors)
    }
  }
}

export interface SyncBundlesResult {
  bundles: number
  productsWithBundles: number
  metafieldsWritten: number
  metafieldsDeleted: number
}

// `sales` = prodané balíčky za posledních N dní podle produktu balíčku
// (bundleSales z aggregateSalesByProduct, počítané přes lineItemGroup).
export async function syncProductBundles(
  sales: Map<string, number>,
  logPrefix = '[sync-bundles]'
): Promise<SyncBundlesResult> {
  const products = await fetchAllProducts()

  // Jen aktivní balíčky — koncept nebo archiv se na e-shopu nezobrazí. Téma navíc
  // kontroluje dostupnost a zveřejnění při vykreslení.
  const bundles = products
    .map((product) => ({ product, components: componentIds(product) }))
    .filter(({ product, components }) => product.status === 'ACTIVE' && components.length > 0)
    .sort((a, b) => (sales.get(b.product.id) ?? 0) - (sales.get(a.product.id) ?? 0))

  const bundlesByComponent = new Map<string, string[]>()
  for (const { product, components } of bundles) {
    for (const componentId of components) {
      const list = bundlesByComponent.get(componentId) ?? []
      list.push(product.id)
      bundlesByComponent.set(componentId, list)
    }
  }
  const componentsByBundle = new Map(bundles.map(({ product, components }) => [product.id, components]))

  const toWrite: MetafieldInput[] = []
  const bundlesToDelete: string[] = []
  const componentsToDelete: string[] = []

  for (const product of products) {
    const productBundles = (bundlesByComponent.get(product.id) ?? []).slice(0, MAX_BUNDLES_PER_PRODUCT)
    if (!sameList(product.bundles, productBundles)) {
      if (productBundles.length > 0) {
        toWrite.push({
          ownerId: product.id,
          namespace: 'custom',
          key: 'bundles',
          type: 'list.product_reference',
          value: JSON.stringify(productBundles),
        })
      } else {
        bundlesToDelete.push(product.id)
      }
    }

    const components = componentsByBundle.get(product.id) ?? []
    if (!sameList(product.bundleComponents, components)) {
      if (components.length > 0) {
        toWrite.push({
          ownerId: product.id,
          namespace: 'custom',
          key: 'bundle_components',
          type: 'list.product_reference',
          value: JSON.stringify(components),
        })
      } else {
        componentsToDelete.push(product.id)
      }
    }
  }

  await setMetafields(toWrite, logPrefix)
  await deleteMetafields(bundlesToDelete, 'bundles', logPrefix)
  await deleteMetafields(componentsToDelete, 'bundle_components', logPrefix)

  return {
    bundles: bundles.length,
    productsWithBundles: bundlesByComponent.size,
    metafieldsWritten: toWrite.length,
    metafieldsDeleted: bundlesToDelete.length + componentsToDelete.length,
  }
}
