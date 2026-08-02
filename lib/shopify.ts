const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP!
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY!
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET!
const API_VERSION = '2026-04'

let cachedToken: string | null = null
let tokenExpiresAt = 0

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken
  }

  const res = await fetch(`https://${SHOPIFY_SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
    }),
  })

  if (!res.ok) {
    throw new Error(`Shopify token refresh failed: ${res.status} ${await res.text()}`)
  }

  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = data.access_token
  tokenExpiresAt = Date.now() + data.expires_in * 1000

  return cachedToken
}

export async function shopifyGraphQL<T = unknown>(
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = await getAccessToken()

  const res = await fetch(
    `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query, variables }),
    }
  )

  if (!res.ok) {
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${await res.text()}`)
  }

  const json = await res.json()

  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`)
  }

  return json.data as T
}

// ── Customer helpers ────────────────────────────────────────────────────────
// Používá je email-first registrační flow: při submitu ověřujeme, zda email už
// existuje (a případně patří k firmě), při approve zakládáme účet neexistujícímu
// emailu.

const CUSTOMER_BY_EMAIL = `
  query customerByEmail($query: String!) {
    customers(first: 5, query: $query) {
      nodes {
        id
        email
        companyContactProfiles { id }
      }
    }
  }
`

const CUSTOMER_CREATE = `
  mutation customerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`

export interface CustomerLookup {
  id: string
  email: string
  // Počet firemních kontaktů zákazníka. > 0 znamená, že email už patří k nějaké firmě.
  companyCount: number
}

// Vrátí zákazníka podle přesné shody emailu, nebo null. Shopify email search umí
// vracet i částečné shody, proto výsledek filtrujeme na přesnou (case-insensitive) shodu.
export async function findCustomerByEmail(email: string): Promise<CustomerLookup | null> {
  const normalized = email.trim().toLowerCase()
  type Result = {
    customers: {
      nodes: { id: string; email: string | null; companyContactProfiles: { id: string }[] }[]
    }
  }
  const { customers } = await shopifyGraphQL<Result>(CUSTOMER_BY_EMAIL, {
    query: `email:${normalized}`,
  })
  const match = customers.nodes.find(n => (n.email ?? '').toLowerCase() === normalized)
  if (!match) return null
  return {
    id: match.id,
    email: match.email ?? normalized,
    companyCount: match.companyContactProfiles.length,
  }
}

// Založí nový zákaznický účet. U "new customer accounts" stačí vytvořit záznam —
// přihlášení pak probíhá přes jednorázový kód na email, žádné heslo se nenastavuje.
export async function createCustomer(input: {
  email: string
  firstName?: string
  lastName?: string
}): Promise<string> {
  type Result = {
    customerCreate: {
      customer: { id: string } | null
      userErrors: { field: string[]; message: string }[]
    }
  }
  const { customerCreate } = await shopifyGraphQL<Result>(CUSTOMER_CREATE, {
    input: {
      email: input.email,
      firstName: input.firstName || undefined,
      lastName: input.lastName || undefined,
    },
  })
  if (customerCreate.userErrors.length > 0) {
    throw new Error(`customerCreate errors: ${JSON.stringify(customerCreate.userErrors)}`)
  }
  return customerCreate.customer!.id
}

// ── Metafields ──────────────────────────────────────────────────────────────

const METAFIELDS_SET = `
  mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`

export interface MetafieldInput {
  ownerId: string
  namespace: string
  key: string
  type: string
  value: string
}

type MetafieldsSetResult = {
  metafieldsSet: {
    metafields: { id: string }[] | null
    userErrors: { field: string[]; message: string; code: string | null }[]
  }
}

async function metafieldsSetBatch(metafields: MetafieldInput[]) {
  const { metafieldsSet } = await shopifyGraphQL<MetafieldsSetResult>(METAFIELDS_SET, { metafields })
  return metafieldsSet.userErrors
}

// metafieldsSet je atomický — jediná neplatná hodnota zahodí celou dávku, takže by
// kvůli jednomu poli zmizely všechny metafieldy firmy. Prázdné hodnoty proto vůbec
// neposíláme (Shopify je odmítá s kódem BLANK; nevyplněné DIČ/poznámka jsou běžné)
// a když dávka přesto selže, zkusíme metafieldy uložit po jednom, ať jeden vadný
// nezabije ostatní. userErrors chodí v HTTP 200, takže bez explicitní kontroly by
// selhání proběhlo tiše.
export async function setMetafields(metafields: MetafieldInput[], logPrefix: string): Promise<void> {
  const payload = metafields.filter(m => m.value.trim() !== '')
  if (payload.length === 0) return

  const errors = await metafieldsSetBatch(payload)
  if (errors.length === 0) return

  console.error(`${logPrefix} metafieldsSet userErrors, retrying one by one`, errors)

  for (const mf of payload) {
    try {
      const single = await metafieldsSetBatch([mf])
      if (single.length > 0) {
        console.error(`${logPrefix} metafieldsSet failed key=${mf.key}`, single)
      }
    } catch (err) {
      console.error(`${logPrefix} metafieldsSet failed key=${mf.key}`, err)
    }
  }
}

export async function shopifyREST<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const token = await getAccessToken()

  const res = await fetch(
    `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}${path}`,
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
        ...options?.headers,
      },
    }
  )

  if (!res.ok) {
    throw new Error(`Shopify REST ${res.status}: ${await res.text()}`)
  }

  return res.json() as Promise<T>
}
