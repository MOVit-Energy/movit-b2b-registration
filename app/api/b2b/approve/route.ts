import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/token'
import { shopifyGraphQL, shopifyREST } from '@/lib/shopify'
import { sendWelcomeEmail } from '@/lib/email'

const B2B_CATALOG_ID = process.env.B2B_CATALOG_ID!

const GET_CUSTOMER = `
  query getCustomer($id: ID!) {
    customer(id: $id) {
      id
      email
      firstName
      lastName
      phone
      tags
      metafields(first: 20, namespace: "custom") {
        nodes { key value }
      }
    }
  }
`

const COMPANY_CREATE = `
  mutation companyCreate($input: CompanyCreateInput!) {
    companyCreate(input: $input) {
      company {
        id
        mainContact { id }
        locations(first: 1) { nodes { id } }
      }
      userErrors { field message code }
    }
  }
`

const CATALOG_CONTEXT_UPDATE = `
  mutation catalogContextUpdate($id: ID!, $input: CatalogContextUpdateInput!) {
    catalogContextUpdate(id: $id, input: $input) {
      catalog { id }
      userErrors { field message code }
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
    lastName: string
    phone: string
    tags: string[]
    metafields: { nodes: { key: string; value: string }[] }
  } | null
}

function metafield(nodes: { key: string; value: string }[], key: string): string {
  return nodes.find(n => n.key === key)?.value ?? ''
}

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token') ?? ''

  const payload = verifyToken(token)
  if (!payload) {
    return htmlResponse('Neplatný token', 'Tento odkaz je neplatný nebo byl pozměněn.', 'error')
  }

  // Load customer
  const result = await shopifyGraphQL<CustomerData>(GET_CUSTOMER, { id: payload.customerId })
  const customer = result.customer

  if (!customer) {
    return htmlResponse('Zákazník nenalezen', 'Zákazník s tímto tokenem neexistuje.', 'error')
  }

  const mf = customer.metafields.nodes

  // Check single-use
  if (metafield(mf, 'approval_token_used') === 'true') {
    return htmlResponse('Token již použit', 'Tento schvalovací odkaz byl již použit.', 'warning')
  }

  const companyName = metafield(mf, 'company_name') || customer.firstName + ' ' + customer.lastName
  const ico = metafield(mf, 'ico')
  const dic = metafield(mf, 'dic')
  const expectedVolume = metafield(mf, 'expected_volume')
  const addressStreet = metafield(mf, 'address_street')
  const addressCity = metafield(mf, 'address_city')
  const addressZip = metafield(mf, 'address_zip')

  // Create Shopify B2B Company
  type CompanyCreateResult = {
    companyCreate: {
      company: {
        id: string
        mainContact: { id: string }
        locations: { nodes: { id: string }[] }
      } | null
      userErrors: { field: string[]; message: string; code: string }[]
    }
  }

  let companyLocationId: string
  try {
    const companyResult = await shopifyGraphQL<CompanyCreateResult>(COMPANY_CREATE, {
      input: {
        company: {
          name: companyName,
          externalId: ico,
          note: `DIČ: ${dic || '—'} | Objem: ${expectedVolume}`,
        },
        companyContact: {
          email: customer.email,
          firstName: customer.firstName,
          lastName: customer.lastName,
          title: 'Hlavní kontakt',
        },
        companyLocation: {
          name: companyName,
          shippingAddress: {
            firstName: customer.firstName,
            lastName: customer.lastName,
            address1: addressStreet,
            city: addressCity,
            zip: addressZip,
            countryCode: 'CZ',
          },
          billingSameAsShipping: true,
        },
      },
    })

    const errors = companyResult.companyCreate.userErrors
    if (errors.length > 0) {
      console.error('[approve] companyCreate errors', errors)
      const isDuplicate = errors.some(e => e.code === 'TAKEN' || e.message.toLowerCase().includes('external'))
      if (isDuplicate) {
        return htmlResponse('Firma již existuje', `Firma s IČO ${ico} je v Shopify již registrována.`, 'warning')
      }
      throw new Error(JSON.stringify(errors))
    }

    companyLocationId = companyResult.companyCreate.company!.locations.nodes[0].id
  } catch (err) {
    console.error('[approve] companyCreate error', err)
    return htmlResponse('Chyba', 'Vytvoření firmy v Shopify selhalo. Zkuste to znovu nebo kontaktujte správce.', 'error')
  }

  // Assign B2B catalog to company location
  if (B2B_CATALOG_ID) {
    try {
      await shopifyGraphQL(CATALOG_CONTEXT_UPDATE, {
        id: B2B_CATALOG_ID,
        input: { contextsToAdd: [{ companyLocationId }] },
      })
    } catch (err) {
      console.error('[approve] catalogContextUpdate error', err)
      // Non-fatal — lze přiřadit ručně v adminu
    }
  }

  // Update customer tags
  const newTags = customer.tags.filter(t => t !== 'b2b-pending').concat('b2b-approved')
  try {
    await shopifyGraphQL(CUSTOMER_UPDATE, {
      input: { id: customer.id, tags: newTags },
    })
  } catch (err) {
    console.error('[approve] customerUpdate error', err)
  }

  // Mark token as used
  try {
    await shopifyGraphQL(METAFIELDS_SET, {
      metafields: [
        { ownerId: customer.id, namespace: 'custom', key: 'approval_token_used', type: 'boolean', value: 'true' },
      ],
    })
  } catch (err) {
    console.error('[approve] metafieldsSet error', err)
  }

  // Get account activation URL and send welcome email
  try {
    const numericId = customer.id.replace('gid://shopify/Customer/', '')
    const activationData = await shopifyREST<{ account_activation_url: string }>(
      `/customers/${numericId}/account_activation_url.json`,
      { method: 'POST' }
    )
    await sendWelcomeEmail(customer.email, customer.firstName, companyName, activationData.account_activation_url)
  } catch (err) {
    console.error('[approve] welcome email error', err)
  }

  console.log(`[approve] approved customerId=${customer.id} ico=${ico}`)
  return htmlResponse('Schváleno', `Firma ${companyName} byla schválena. Zákazník (${customer.email}) obdržel welcome email s aktivačním odkazem.`, 'success')
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
