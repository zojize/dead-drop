import { useState, useEffect, useRef, useCallback } from 'react'
import { encode, decode } from '@zojize/dead-drop'
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string'
import './playground.css'

const PLACEHOLDER = 'the quick brown fox jumps over the lazy dog'

interface UrlState { input: string; seed?: number }

function loadFromUrl(): UrlState | null {
  const params = new URLSearchParams(window.location.search)
  const s = params.get('s')
  if (!s) return null
  try {
    const json = decompressFromEncodedURIComponent(s)
    return json ? JSON.parse(json) : null
  } catch { return null }
}

function saveToUrl(state: UrlState) {
  const compressed = compressToEncodedURIComponent(JSON.stringify(state))
  const url = `${window.location.pathname}?s=${compressed}${window.location.hash}`
  history.replaceState(null, '', url)
}

export function Playground() {
  const restored = useRef(loadFromUrl())
  const [input, setInputRaw] = useState(restored.current?.input ?? '')
  const [seed, setSeed] = useState<number | undefined>(restored.current?.seed)
  const [encoded, setEncodedRaw] = useState('')
  const [decoded, setDecoded] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [encodeMs, setEncodeMs] = useState<number | null>(null)
  const [decodeMs, setDecodeMs] = useState<number | null>(null)
  const dirRef = useRef<'encode' | 'decode'>('encode')
  const initialized = useRef(false)

  const setInput = useCallback((val: string) => {
    dirRef.current = 'encode'
    setInputRaw(val)
  }, [])

  const setEncoded = useCallback((val: string) => {
    dirRef.current = 'decode'
    setEncodedRaw(val)
  }, [])

  useEffect(() => {
    if (dirRef.current !== 'encode') return
    try {
      setError('')
      if (!input) { setEncodedRaw(''); setDecoded(''); setEncodeMs(null); return }
      const t0 = performance.now()
      const js = encode(new TextEncoder().encode(input), { seed })
      setEncodeMs(performance.now() - t0)
      setEncodedRaw(js)
    } catch (e: any) { setError(e.message) }
  }, [input, seed])

  useEffect(() => {
    if (dirRef.current !== 'decode') return
    setDecoded('')
    setDecodeMs(null)
    const t = setTimeout(() => {
      try {
        setError('')
        if (!encoded) { setDecoded(''); return }
        const t0 = performance.now()
        const bytes = decode(encoded)
        setDecodeMs(performance.now() - t0)
        setDecoded(new TextDecoder().decode(bytes))
      } catch (e: any) { setError(e.message) }
    }, 250)
    return () => clearTimeout(t)
  }, [encoded])

  const displayDecoded = dirRef.current === 'encode' ? input : decoded

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      if (!restored.current) setInput(PLACEHOLDER)
    }
  }, [setInput])

  useEffect(() => {
    if (dirRef.current !== 'encode') return
    const t = setTimeout(() => { if (input) saveToUrl({ input, seed }) }, 400)
    return () => clearTimeout(t)
  }, [input, seed])

  const share = useCallback(async () => {
    saveToUrl({ input, seed })
    await navigator.clipboard.writeText(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [input, seed])

  const timing = encodeMs !== null || decodeMs !== null
    ? [
        encodeMs !== null ? `enc ${encodeMs.toFixed(0)}ms` : '',
        decodeMs !== null ? `dec ${decodeMs.toFixed(0)}ms` : '',
      ].filter(Boolean).join(' · ')
    : ''

  return (
    <div className="sp">
        <div className="sp-left">
          <div className="sp-top">
            <div className="sp-tag">Plaintext</div>
            <div className="sp-tag">{input.length} chars</div>
          </div>
          <div className="sp-h">Your message</div>
          <textarea
            className="sp-area"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Start typing..."
            spellCheck={false}
            autoFocus
          />
          <div className="sp-footer">
            <a href="https://github.com/zojize/dead-drop" target="_blank" rel="noopener" style={{ color: 'inherit', textDecoration: 'none' }}>dead-drop</a>
            <div className="sp-seed">
              <label>seed</label>
              <input
                type="text"
                inputMode="numeric"
                value={seed ?? ''}
                onChange={e => {
                  const v = e.target.value
                  if (v === '') { setSeed(undefined); dirRef.current = 'encode'; return }
                  const n = parseInt(v, 10)
                  if (!isNaN(n)) { setSeed(n); dirRef.current = 'encode' }
                }}
                placeholder="auto"
              />
            </div>
            <button className="sp-share" onClick={share}>
              {copied ? 'copied!' : 'share'}
            </button>
          </div>
        </div>
        <div className="sp-seam" />
        <div className="sp-right">
          <div className="sp-top">
            <div className="sp-tag">Encoded JavaScript</div>
            <div className="sp-tag">{encoded.length} chars{timing && ` · ${timing}`}</div>
          </div>
          <div className="sp-h">// output</div>
          <textarea
            className="sp-area"
            value={encoded}
            onChange={e => setEncoded(e.target.value)}
            placeholder="// or paste JS here to decode..."
            spellCheck={false}
          />
          <div className="sp-footer">
            {displayDecoded && (
              <div className="sp-decoded">decoded: <span>{displayDecoded}</span></div>
            )}
            {error && <div className="sp-err">{error}</div>}
            <span style={{ marginLeft: 'auto' }}>{encoded ? `${(encoded.length / Math.max(input.length, 1)).toFixed(1)}x` : ''}</span>
          </div>
        </div>
      </div>
  )
}
