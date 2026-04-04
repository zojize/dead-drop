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
  // Ref is set synchronously in onChange, always correct by render time.
  // Using state here causes batching issues where the display condition
  // evaluates before the direction update is committed.
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

  // Encode on input or seed change
  useEffect(() => {
    if (dirRef.current !== 'encode') return
    try {
      setError('')
      if (!input) { setEncodedRaw(''); setDecoded(''); return }
      setEncodedRaw(encode(new TextEncoder().encode(input), seed))
    } catch (e: any) { setError(e.message) }
  }, [input, seed])

  // Decode on encoded change (debounced, only in decode mode)
  useEffect(() => {
    if (dirRef.current !== 'decode') return
    setDecoded('')
    const t = setTimeout(() => {
      try {
        setError('')
        if (!encoded) { setDecoded(''); return }
        setDecoded(new TextDecoder().decode(decode(encoded)))
      } catch (e: any) { setError(e.message) }
    }, 250)
    return () => clearTimeout(t)
  }, [encoded])

  // In encode mode, derive decoded from input (synchronous, never stale).
  // In decode mode, use the debounced decoded state.
  const displayDecoded = dirRef.current === 'encode' ? input : decoded

  // Auto-fill placeholder on first mount if no URL state
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true
      if (!restored.current) setInput(PLACEHOLDER)
    }
  }, [setInput])

  // Persist to URL (debounced)
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
            <span>dead-drop</span>
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
            <div className="sp-tag">{encoded.length} chars</div>
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
            <span style={{ marginLeft: 'auto' }}>{encoded ? `${(encoded.length / Math.max(input.length, 1)).toFixed(1)}x expansion` : ''}</span>
          </div>
        </div>
      </div>
  )
}
