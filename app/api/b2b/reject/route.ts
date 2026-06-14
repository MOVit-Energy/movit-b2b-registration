import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/token'
import { shopifyGraphQL } from '@/lib/shopify'
import { sendRejectionEmail } from '@/lib/email'

const GET_CUSTOMER = `
  query getCustomer($id: ID!) {
    customer(id: $id) {
      id
      email
      firstName
      tags
      metafields(first: 5, namespace: "custom") {
        nodes { key value }
      }
    }
  }
`

const CUSTOMER_UPDATE = `
  mutation customerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id tags }
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

type CustomerData = {
  customer: {
    id: string
    email: string
    firstName: string
    tags: string[]
    metafields: { nodes: { key: string; value: string }[] }
  } | null
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? ''

  const payload = verifyToken(token)
  if (!payload) {
    return htmlResponse('Neplatný token', 'Tento odkaz je neplatný nebo byl pozměněn.', 'error')
  }

  const result = await shopifyGraphQL<CustomerData>(GET_CUSTOMER, { id: payload.customerId })
  const customer = result.customer

  if (!customer) {
    return htmlResponse('Zákazník nenalezen', 'Zákazník s tímto tokenem neexistuje.', 'error')
  }

  const tokenUsed = customer.metafields.nodes.find(n => n.key === 'approval_token_used')?.value
  if (tokenUsed === 'true') {
    return htmlResponse('Token již použit', 'Tento schvalovací odkaz byl již použit.', 'warning')
  }

  // Mark token as used
  try {
    await shopifyGraphQL(METAFIELDS_SET, {
      metafields: [
        { ownerId: customer.id, namespace: 'custom', key: 'approval_token_used', type: 'boolean', value: 'true' },
      ],
    })
  } catch (err) {
    console.error('[reject] metafieldsSet error', err)
  }

  // Update customer tags
  const newTags = customer.tags.filter(t => t !== 'b2b-pending').concat('b2b-rejected')
  try {
    await shopifyGraphQL(CUSTOMER_UPDATE, {
      input: { id: customer.id, tags: newTags },
    })
  } catch (err) {
    console.error('[reject] customerUpdate error', err)
  }

  // Send rejection email
  try {
    await sendRejectionEmail(customer.email, customer.firstName)
  } catch (err) {
    console.error('[reject] sendRejectionEmail error', err)
  }

  console.log(`[reject] rejected customerId=${customer.id}`)
  return htmlResponse('Zamítnuto', `Žádost zákazníka (${customer.email}) byla zamítnuta. Zákazník byl informován emailem.`, 'success')
}

function htmlResponse(title: string, message: string, type: 'success' | 'warning' | 'error'): NextResponse {
  const colors = { success: '#16a34a', warning: '#d97706', error: '#dc2626' }
  const color = colors[type]
  return new NextResponse(
    `<!DOCTYPE html><html lang="cs"><head><meta charset="UTF-8"><title>${title}</title>
    <style>body{font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb}
    .box{background:#fff;border-radius:8px;padding:40px;max-width:480px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}
    h1{color:${color};margin-bottom:12px}p{color:#555;line-height:1.6}</style></head>
    <body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )
}
