import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/token'
import { shopifyGraphQL } from '@/lib/shopify'
import { sendRejectionEmail } from '@/lib/email'

const GET_COMPANY = `
  query getCompany($id: ID!) {
    company(id: $id) {
      id
      name
      metafields(first: 20, namespace: "custom") {
        nodes { key value }
      }
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

  const result = await shopifyGraphQL<CompanyData>(GET_COMPANY, { id: payload.companyId })
  const company = result.company

  if (!company) {
    return htmlResponse('Firma nenalezena', 'Firma s tímto tokenem neexistuje.', 'error')
  }

  const mf = company.metafields.nodes

  if (metafield(mf, 'approval_token_used') === 'true') {
    return htmlResponse('Odkaz již použit', 'Tento schvalovací odkaz byl již použit.', 'warning')
  }

  const contactEmail = metafield(mf, 'contact_email') || payload.email
  const contactFirstName = metafield(mf, 'contact_first_name')

  // Označíme odkaz jako použitý + status zamítnuto. Firmu i customera necháváme
  // beze změny (customera neupravujeme; firmu lze případně smazat ručně v adminu).
  try {
    await shopifyGraphQL(METAFIELDS_SET, {
      metafields: [
        { ownerId: company.id, namespace: 'custom', key: 'approval_token_used', type: 'boolean', value: 'true' },
        { ownerId: company.id, namespace: 'custom', key: 'b2b_status', type: 'single_line_text_field', value: 'rejected' },
      ],
    })
  } catch (err) {
    console.error('[reject] metafieldsSet error', err)
  }

  // Rejection email (Klaviyo)
  try {
    await sendRejectionEmail(contactEmail, contactFirstName)
  } catch (err) {
    console.error('[reject] sendRejectionEmail error', err)
  }

  console.log(`[reject] rejected companyId=${company.id}`)
  return htmlResponse('Zamítnuto', `Žádost firmy ${company.name} (${contactEmail}) byla zamítnuta. Kontakt byl informován emailem.`, 'success')
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
