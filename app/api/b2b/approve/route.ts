import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/token'
import { shopifyGraphQL } from '@/lib/shopify'
import { sendWelcomeEmail } from '@/lib/email'

const SHOP_URL = process.env.SHOP_URL!.replace(/\/+$/, '')

// Company i kontakt (customer) už existují a firma je při registraci přiřazena do
// B2B marketu (viz submit). Při approve jen přiřadíme existujícího customera jako
// kontakt firmy, aby mohl objednávat. Customera neupravujeme.
const GET_COMPANY = `
  query getCompany($id: ID!) {
    company(id: $id) {
      id
      name
      locations(first: 1) { nodes { id } }
      contactRoles(first: 10) { nodes { id name } }
      metafields(first: 20, namespace: "custom") {
        nodes { key value }
      }
    }
  }
`

const ASSIGN_CUSTOMER_AS_CONTACT = `
  mutation companyAssignCustomerAsContact($companyId: ID!, $customerId: ID!) {
    companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) {
      companyContact { id }
      userErrors { field message code }
    }
  }
`

const ASSIGN_MAIN_CONTACT = `
  mutation companyAssignMainContact($companyId: ID!, $companyContactId: ID!) {
    companyAssignMainContact(companyId: $companyId, companyContactId: $companyContactId) {
      company { id }
      userErrors { field message code }
    }
  }
`

const CONTACT_ASSIGN_ROLE = `
  mutation companyContactAssignRole($companyContactId: ID!, $companyContactRoleId: ID!, $companyLocationId: ID!) {
    companyContactAssignRole(companyContactId: $companyContactId, companyContactRoleId: $companyContactRoleId, companyLocationId: $companyLocationId) {
      companyContactRoleAssignment { id }
      userErrors { field message code }
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

type CompanyData = {
  company: {
    id: string
    name: string
    locations: { nodes: { id: string }[] }
    contactRoles: { nodes: { id: string; name: string }[] }
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

  // Load company
  const result = await shopifyGraphQL<CompanyData>(GET_COMPANY, { id: payload.companyId })
  const company = result.company

  if (!company) {
    return htmlResponse('Firma nenalezena', 'Firma s tímto tokenem neexistuje.', 'error')
  }

  const mf = company.metafields.nodes

  // Check single-use
  if (metafield(mf, 'approval_token_used') === 'true') {
    return htmlResponse('Odkaz již použit', 'Tento schvalovací odkaz byl již použit.', 'warning')
  }

  const customerId = metafield(mf, 'customer')
  if (!customerId) {
    return htmlResponse('Chybí kontakt', 'K firmě není přiřazen žádný zákazník.', 'error')
  }

  const contactEmail = metafield(mf, 'contact_email') || payload.email
  const contactFirstName = metafield(mf, 'contact_first_name')
  const companyLocationId = company.locations.nodes[0]?.id

  if (!companyLocationId) {
    return htmlResponse('Chyba', 'Firma nemá lokaci, nelze ji dokončit.', 'error')
  }

  // Přiřadíme existujícího customera jako kontakt firmy + roli + katalog.
  type AssignContactResult = {
    companyAssignCustomerAsContact: {
      companyContact: { id: string } | null
      userErrors: { field: string[]; message: string; code: string }[]
    }
  }

  try {
    const assignResult = await shopifyGraphQL<AssignContactResult>(ASSIGN_CUSTOMER_AS_CONTACT, {
      companyId: company.id,
      customerId,
    })
    const assignErrors = assignResult.companyAssignCustomerAsContact.userErrors
    if (assignErrors.length > 0) {
      console.error('[approve] companyAssignCustomerAsContact errors', assignErrors)
      throw new Error(JSON.stringify(assignErrors))
    }
    const companyContactId = assignResult.companyAssignCustomerAsContact.companyContact!.id

    // Hlavní kontakt firmy
    await shopifyGraphQL(ASSIGN_MAIN_CONTACT, { companyId: company.id, companyContactId })

    // Role na lokaci, aby mohl objednávat (preferujeme admin roli)
    const roles = company.contactRoles.nodes
    const role = roles.find(r => /admin/i.test(r.name)) ?? roles[0]
    if (role) {
      await shopifyGraphQL(CONTACT_ASSIGN_ROLE, {
        companyContactId,
        companyContactRoleId: role.id,
        companyLocationId,
      })
    } else {
      console.error('[approve] žádná company contact role k přiřazení')
    }
  } catch (err) {
    console.error('[approve] assign contact error', err)
    return htmlResponse('Chyba', 'Přiřazení kontaktu k firmě selhalo. Zkuste to znovu nebo kontaktujte správce.', 'error')
  }

  // Označíme odkaz jako použitý + status
  try {
    await shopifyGraphQL(METAFIELDS_SET, {
      metafields: [
        { ownerId: company.id, namespace: 'custom', key: 'approval_token_used', type: 'boolean', value: 'true' },
        { ownerId: company.id, namespace: 'custom', key: 'b2b_status', type: 'single_line_text_field', value: 'approved' },
      ],
    })
  } catch (err) {
    console.error('[approve] metafieldsSet error', err)
  }

  // Welcome email (Klaviyo) — bez aktivace, customer už má účet
  try {
    await sendWelcomeEmail(contactEmail, contactFirstName, company.name, `${SHOP_URL}/account`)
  } catch (err) {
    console.error('[approve] welcome email error', err)
  }

  console.log(`[approve] approved companyId=${company.id}`)
  return htmlResponse('Schváleno', `Firma ${company.name} byla schválena. Kontakt (${contactEmail}) obdržel potvrzovací email a získal přístup k B2B katalogu.`, 'success')
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
