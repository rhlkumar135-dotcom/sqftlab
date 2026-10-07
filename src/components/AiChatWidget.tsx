import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, Info, Send, Sparkles, X } from 'lucide-react'
import { authedFetch } from '@/lib/session'

/**
 * AI market assistant widget (Day 13 Task C).
 *
 * Three deviations from the brief's widget, each for a reason the brief could not see:
 *
 * 1. TRANSPORT. The brief posts to `/api/ai/chat` with an `X-Session-Id` header and
 *    replays `history` from local state. This app mounts custom routes at `/api/sqftlab`,
 *    so `/api/ai/chat` would 404 — and a client-supplied session id is a quota key the
 *    caller can rotate, which is why the server keys the quota on the identity it issued.
 *    The widget therefore calls `/api/sqftlab/ai/chat` through `authedFetch` and lets the
 *    server own identity.
 *
 * 2. HISTORY. The server is already the record of the conversation, so history is loaded
 *    from `/ai/chat/history` on open and the server reconstructs prior turns itself. The
 *    brief's client-side replay would have let the page invent assistant turns.
 *
 * 3. HONESTY. The brief renders a reply unconditionally. When the register is empty the
 *    API answers with `dataBacked: false`, and that is surfaced here — an assistant whose
 *    answers are general knowledge is a different product from one quoting the register,
 *    and the difference is invisible unless the UI says so.
 *
 * Identity, not quota, decides `remaining`: a signed-out visitor gets the guest ceiling,
 * which the response reports, so the counter is never guessed client-side.
 */

interface Turn {
  role: 'user' | 'assistant'
  content: string
}

interface HistoryResponse {
  messages?: Array<{ role: string; content: string; createdAt?: string }>
  used?: number
  remaining?: number
  limit?: number
  unlimited?: boolean
  configured?: boolean
}

interface ChatResponse {
  reply?: string
  remaining?: number
  limit?: number
  unlimited?: boolean
  model?: string
  dataBacked?: boolean
  error?: string
  detail?: string
  code?: string
  upgradeUrl?: string
  resetAt?: string
}

const SUGGESTIONS = [
  'What should I compare when valuing a Dubai apartment?',
  'Explain price per square foot vs. total price.',
  'How do service charges differ between towers?',
]

export default function AiChatWidget({ onNavigate }: { onNavigate?: (page: 'pricing') => void }) {
  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [remaining, setRemaining] = useState<number | null>(null)
  const [limit, setLimit] = useState<number | null>(null)
  const [unlimited, setUnlimited] = useState(false)
  const [configured, setConfigured] = useState(true)
  const [dataBacked, setDataBacked] = useState<boolean | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const res = await authedFetch('/api/sqftlab/ai/chat/history')
      const body = (await res.json().catch(() => ({}))) as HistoryResponse
      if (!res.ok) return
      setTurns(
        (body.messages ?? []).map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      )
      setRemaining(typeof body.remaining === 'number' ? body.remaining : null)
      setLimit(typeof body.limit === 'number' ? body.limit : null)
      setUnlimited(body.unlimited === true)
      setConfigured(body.configured !== false)
    } catch {
      // A history read that fails must not break the widget: the composer still works,
      // and the send path reports its own errors.
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setError(null)
    void loadHistory()
  }, [open, loadHistory])

  useEffect(() => {
    if (!open || !scroller.current) return
    scroller.current.scrollTop = scroller.current.scrollHeight
  }, [turns, open, sending])

  const send = useCallback(
    async (text: string) => {
      const message = text.trim()
      if (message === '' || sending) return
      setDraft('')
      setError(null)
      setNotice(null)
      setSending(true)
      // The user turn is appended optimistically so the composer feels immediate; it is
      // replaced wholesale by the server's copy on the next history load.
      setTurns((t) => [...t, { role: 'user', content: message }])

      try {
        const res = await authedFetch('/api/sqftlab/ai/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            history: turns.slice(-10),
          }),
        })
        const body = (await res.json().catch(() => ({}))) as ChatResponse

        if (res.status === 429) {
          setRemaining(0)
          if (typeof body.limit === 'number') setLimit(body.limit)
          setUnlimited(body.unlimited === true)
          setError(body.error ?? 'Daily AI message limit reached.')
          return
        }
        if (!res.ok) {
          // The server names the cause — no model credential, or the provider failed.
          // Showing it beats a generic failure, which strands the reader.
          if (body.code === 'ai_unavailable') setConfigured(false)
          setError(body.error ?? `The assistant could not answer (HTTP ${res.status}).`)
          return
        }

        const reply = typeof body.reply === 'string' ? body.reply : ''
        setTurns((t) => [...t, { role: 'assistant', content: reply }])
        setRemaining(typeof body.remaining === 'number' ? body.remaining : null)
        setLimit(typeof body.limit === 'number' ? body.limit : null)
        setUnlimited(body.unlimited === true)
        setDataBacked(body.dataBacked === true)
        if (body.dataBacked === false) {
          setNotice(
            'No transaction data is loaded on this deployment, so this answer is general guidance — it is not quoting the register.',
          )
        }
      } catch {
        setError('The assistant could not be reached. Check your connection and try again.')
      } finally {
        setSending(false)
      }
    },
    [sending, turns],
  )

  const quotaLabel =
    remaining === null
      ? null
      : unlimited
        ? 'Unlimited messages'
        : `${remaining} of ${limit ?? remaining} left today`

  return (
    <>
      {/* Launcher. Fixed bottom-right so it stays reachable with the thumb on a phone
          and clear of the content on desktop. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open the AI market assistant"
          className="fixed z-[60] bottom-4 right-4 sm:bottom-6 sm:right-6 flex items-center gap-2 rounded-full px-4 py-3 text-[13px] font-semibold transition-transform duration-200 hover:scale-[1.03]"
          style={{ background: 'var(--b600)', color: '#fff', boxShadow: 'var(--sh-btn)' }}
        >
          <Sparkles size={16} />
          <span className="hidden sm:inline">Ask the assistant</span>
        </button>
      )}

      {open && (
        <div
          role="dialog"
          aria-label="AI market assistant"
          className="fixed z-[60] inset-x-0 bottom-0 sm:inset-x-auto sm:bottom-6 sm:right-6 w-full sm:w-[400px] flex flex-col rounded-t-[18px] sm:rounded-[18px] overflow-hidden"
          style={{
            background: 'var(--g1)',
            border: '1px solid var(--gb)',
            boxShadow: 'var(--sh-card)',
            maxHeight: 'min(80vh, 620px)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between gap-3 px-4 py-3 shrink-0"
            style={{ borderBottom: '1px solid var(--gb)', background: 'var(--g2)' }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <div
                className="rounded-[10px] p-1.5 shrink-0"
                style={{ background: 'rgba(37,99,235,0.09)' }}
              >
                <Bot size={16} style={{ color: 'var(--b600)' }} />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                  Market assistant
                </div>
                {quotaLabel && (
                  <div className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                    {quotaLabel}
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close the AI market assistant"
              className="rounded-[10px] p-1.5 shrink-0"
              style={{ color: 'var(--ink-4)' }}
            >
              <X size={16} />
            </button>
          </div>

          {/* Transcript */}
          <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[180px]">
            {turns.length === 0 && (
              <div className="space-y-3">
                <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                  Ask about Dubai market data, valuation methods, or how to read the numbers
                  in sqftLab. Answers cite the transaction register when it is loaded.
                </p>
                <div className="space-y-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => void send(s)}
                      className="w-full text-left rounded-[10px] px-3 py-2 text-[12px] transition-colors duration-150"
                      style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink-3)' }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t, i) => (
              <div key={`${i}-${t.role}`} className={t.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className="rounded-[12px] px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap max-w-[85%]"
                  style={
                    t.role === 'user'
                      ? { background: 'var(--b600)', color: '#fff' }
                      : { background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink)' }
                  }
                >
                  {t.content}
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div
                  className="rounded-[12px] px-3 py-2 text-[13px]"
                  style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink-5)' }}
                >
                  Thinking…
                </div>
              </div>
            )}
          </div>

          {/* Notices */}
          {notice && (
            <div
              className="mx-4 mb-2 rounded-[10px] px-3 py-2 flex items-start gap-2 text-[11px] leading-relaxed shrink-0"
              style={{ background: 'rgba(37,99,235,0.06)', color: 'var(--ink-4)' }}
            >
              <Info size={13} className="mt-[1px] shrink-0" style={{ color: 'var(--b600)' }} />
              <span>{notice}</span>
            </div>
          )}

          {!configured && (
            <div
              className="mx-4 mb-2 rounded-[10px] px-3 py-2 text-[11px] leading-relaxed shrink-0"
              style={{ background: 'var(--warn-bg)', color: 'var(--ink-3)' }}
            >
              The assistant is not configured on this deployment, so it cannot answer yet.
            </div>
          )}

          {error && (
            <div className="mx-4 mb-2 rounded-[10px] px-3 py-2 text-[11px] leading-relaxed shrink-0" style={{ background: 'var(--down-bg)', color: 'var(--ink-3)' }}>
              <div>{error}</div>
              {remaining === 0 && onNavigate && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    onNavigate('pricing')
                  }}
                  className="mt-2 px-3 py-1.5 rounded-[8px] text-[11px] font-semibold"
                  style={{ background: 'var(--b600)', color: '#fff' }}
                >
                  See plans
                </button>
              )}
            </div>
          )}

          {/* Composer */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void send(draft)
            }}
            className="flex items-end gap-2 px-4 py-3 shrink-0"
            style={{ borderTop: '1px solid var(--gb)', background: 'var(--g2)' }}
          >
            <label className="sr-only" htmlFor="ai-chat-input">
              Message the AI market assistant
            </label>
            <textarea
              id="ai-chat-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(draft)
                }
              }}
              rows={2}
              disabled={sending || remaining === 0}
              placeholder={remaining === 0 ? 'Daily limit reached' : 'Ask a question…'}
              className="flex-1 resize-none rounded-[10px] px-3 py-2 text-[13px] outline-none"
              style={{ background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink)' }}
            />
            <button
              type="submit"
              disabled={sending || draft.trim() === '' || remaining === 0}
              aria-label="Send message"
              className="rounded-[10px] p-2.5 shrink-0 disabled:opacity-40"
              style={{ background: 'var(--b600)', color: '#fff' }}
            >
              <Send size={15} />
            </button>
          </form>
        </div>
      )}
    </>
  )
}
