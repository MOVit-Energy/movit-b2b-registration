// Jednorázový setup skript — zaregistruje metafield definitions, aby se pole
// zobrazovala v Shopify Adminu se správným editorem místo neviditelných raw metafieldů.
// Spuštění: node --env-file=.env.local --experimental-strip-types scripts/create-metafield-definitions.ts
import { shopifyGraphQL } from '../lib/shopify.ts'

const MUTATION = `
  mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id namespace key }
      userErrors { field message code }
    }
  }
`

interface DefinitionInput {
  name: string
  namespace: string
  key: string
  type: string
  ownerType: 'PRODUCT' | 'ORDER'
  description?: string
}

const DEFINITIONS: DefinitionInput[] = [
  {
    name: 'E-mail: Podnadpis',
    namespace: 'custom',
    key: 'email_subtitle',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
    description:
      'Podnadpis produktu v poobjednávkovém e-mailu. Bez vyplnění se produkt do e-mailu nezahrne.',
  },
  {
    name: 'E-mail: Odrážky',
    namespace: 'custom',
    key: 'email_bullets',
    type: 'json',
    ownerType: 'PRODUCT',
    description:
      'Pole objektů { "title": "...", "text": "..." } (např. DÁVKOVÁNÍ / KDY UŽÍVAT / JAK DLOUHO), libovolný počet.',
  },
  {
    name: 'E-mail: Na co při užívání myslet',
    namespace: 'custom',
    key: 'email_usage_note',
    type: 'multi_line_text_field',
    ownerType: 'PRODUCT',
    description: 'Text pod nadpisem "💡 Na co při užívání myslet?". Prázdné = blok se v e-mailu skryje.',
  },
  {
    name: 'E-mail: Obrázek recenze',
    namespace: 'custom',
    key: 'email_review_image_url',
    type: 'single_line_text_field',
    ownerType: 'PRODUCT',
    description: 'URL obrázku s recenzí. Prázdné = blok se v e-mailu skryje.',
  },
  {
    name: 'Bestseller rank (90 dní)',
    namespace: 'custom',
    key: 'bestseller_rank_90d',
    type: 'number_integer',
    ownerType: 'PRODUCT',
    description: 'Automaticky dopočítáváno týdenním cronem (sync-bestsellers). 1 = nejprodávanější.',
  },
  {
    name: 'Poobjednávkový e-mail odeslán',
    namespace: 'custom',
    key: 'followup_email_sent_at',
    type: 'date_time',
    ownerType: 'ORDER',
    description: 'Automaticky nastavováno cronem send-order-followups po úspěšném odeslání.',
  },
]

for (const definition of DEFINITIONS) {
  const result = await shopifyGraphQL<{
    metafieldDefinitionCreate: {
      createdDefinition: { id: string; namespace: string; key: string } | null
      userErrors: { field: string[]; message: string; code: string }[]
    }
  }>(MUTATION, { definition })

  const { createdDefinition, userErrors } = result.metafieldDefinitionCreate
  if (createdDefinition) {
    console.log(`created ${createdDefinition.namespace}.${createdDefinition.key}`)
  } else {
    console.error(`FAILED ${definition.namespace}.${definition.key}`, userErrors)
  }
}
