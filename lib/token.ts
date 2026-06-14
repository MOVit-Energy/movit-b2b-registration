import crypto from 'crypto'

const SECRET = process.env.APPROVAL_TOKEN_SECRET!

export interface TokenPayload {
  customerId: string
  email: string
}

export function signToken(customerId: string, email: string): string {
  const payload = Buffer.from(JSON.stringify({ customerId, email })).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
  return `${payload}.${sig}`
}

export function verifyToken(token: string): TokenPayload | null {
  const dotIndex = token.lastIndexOf('.')
  if (dotIndex === -1) return null

  const payload = token.slice(0, dotIndex)
  const sig = token.slice(dotIndex + 1)

  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex')

  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) {
      return null
    }
  } catch {
    return null
  }

  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as TokenPayload
  } catch {
    return null
  }
}
