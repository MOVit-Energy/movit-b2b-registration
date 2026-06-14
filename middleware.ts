import { NextRequest, NextResponse } from 'next/server'

// Povolené originy (čárkou oddělené v ALLOWED_ORIGINS), fallback na storefront.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? process.env.SHOP_URL ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
  }
  return headers
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin')

  // Preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
  }

  const response = NextResponse.next()
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    response.headers.set(key, value)
  }
  return response
}

export const config = {
  matcher: '/api/:path*',
}
