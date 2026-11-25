'use client'

import { useState } from 'react'

// Odhlašovací stránka z SMS. Zákazník vybere mezinárodní předvolbu a zadá číslo;
// předvolba + číslice se spojí a pošlou na /api/sms/unsubscribe, kde se číslo
// znormalizuje na E.164 (normalizePhone ořeže mezery, tečky, pomlčky) a profil
// se odhlásí z SMS marketingu v Klaviyu.

const PREFIXES = [
  { code: '+420', label: 'Česko +420' },
  { code: '+421', label: 'Slovensko +421' },
  { code: '+48', label: 'Polsko +48' },
  { code: '+49', label: 'Německo +49' },
  { code: '+43', label: 'Rakousko +43' },
  { code: '+44', label: 'UK +44' },
]

const TEAL = '#004751'

export default function OdhlaseniSmsPage() {
  const [prefix, setPrefix] = useState('+420')
  const [number, setNumber] = useState('')
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setState('loading')
    setMessage('')
    // Ořež vše kromě číslic (tečky, pomlčky, mezery, závorky) a spoj s předvolbou.
    const digits = number.replace(/\D/g, '')
    if (!digits) {
      setState('error')
      setMessage('Zadejte prosím telefonní číslo.')
      return
    }
    try {
      const res = await fetch('/api/sms/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: `${prefix}${digits}` }),
      })
      const data = await res.json()
      if (res.ok) {
        setState('done')
        setMessage(data.message || 'Byli jste odhlášeni z odběru SMS.')
      } else {
        setState('error')
        setMessage(data.error || 'Odhlášení se nezdařilo.')
      }
    } catch {
      setState('error')
      setMessage('Odhlášení se nezdařilo, zkuste to prosím později.')
    }
  }

  return (
    <main
      style={{
        fontFamily: 'Arial, Helvetica, sans-serif',
        maxWidth: 440,
        margin: '0 auto',
        padding: '48px 20px',
        color: '#1a1a1a',
      }}
    >
      <h1 style={{ color: TEAL, fontSize: 24, marginBottom: 8 }}>Odhlášení ze zpráv</h1>
      <p style={{ color: '#555', lineHeight: 1.5, marginBottom: 24 }}>
        Zadejte telefonní číslo, na které vám chodí naše SMS, a odhlásíme vás z našich
        sdělení (e-maily i SMS).
      </p>

      {state === 'done' ? (
        <div
          style={{
            background: '#E3F6E8',
            border: '1px solid #9FD8AE',
            borderRadius: 10,
            padding: '16px 18px',
            color: '#1e5631',
          }}
        >
          ✓ {message}
        </div>
      ) : (
        <form onSubmit={submit}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <select
              value={prefix}
              onChange={e => setPrefix(e.target.value)}
              style={{
                flex: '0 0 auto',
                padding: '12px 10px',
                border: '1px solid #cfd6d7',
                borderRadius: 8,
                fontSize: 15,
                background: '#fff',
              }}
              aria-label="Mezinárodní předvolba"
            >
              {PREFIXES.map(p => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
            </select>
            <input
              type="tel"
              inputMode="numeric"
              value={number}
              onChange={e => setNumber(e.target.value)}
              placeholder="724 350 130"
              style={{
                flex: 1,
                padding: '12px 12px',
                border: '1px solid #cfd6d7',
                borderRadius: 8,
                fontSize: 15,
                minWidth: 0,
              }}
              aria-label="Telefonní číslo"
            />
          </div>

          {state === 'error' && (
            <p style={{ color: '#c0392b', fontSize: 14, margin: '0 0 12px' }}>{message}</p>
          )}

          <button
            type="submit"
            disabled={state === 'loading'}
            style={{
              width: '100%',
              padding: '13px 16px',
              background: TEAL,
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: 16,
              fontWeight: 700,
              cursor: state === 'loading' ? 'default' : 'pointer',
              opacity: state === 'loading' ? 0.7 : 1,
            }}
          >
            {state === 'loading' ? 'Odhlašuji…' : 'Odhlásit z SMS'}
          </button>
        </form>
      )}
    </main>
  )
}
