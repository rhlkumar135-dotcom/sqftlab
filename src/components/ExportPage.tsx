import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileSpreadsheet, FileText, Info, Lock, Clock } from 'lucide-react'
import { authedFetch } from '@/lib/session'

/**
 * Export Centre (Day 11 Task D).
 *
 * Two deviations from the spec's design, both because the spec's version cannot
 * work:
 *
 *  - The spec has this page poll `/api/v1/transactions?limit=1` for the row
 *    count. That endpoint is API-KEY authenticated, and this page holds a
 *    SESSION, so the call would 401 for every user. The count comes from
 *    `/api/sqftlab/export/preview`, which is session-authenticated and returns
 *    the same total plus the tier's cap.
 *  - The spec greys out Excel from a client-side tier string. Entitlement is
 *    decided server-side (`excelAllowed` in the preview response), so the UI
 *    reflects the answer rather than guessing it — and the server refuses
 *    regardless of what the button does.
 */

interface Preview {
  total: number
  willExport: number
  rowLimit: number
  unlimited: boolean
  truncated: boolean
  excelAllowed: boolean
  tier: string
  empty: boolean
  message?: string
}

interface ExportEvent {
  id: string
  eventData: { format?: string; rows?: number; area?: string | null } | null
  createdAt: string
}

const BEDROOM_OPTIONS = ['Any', '1', '2', '3', '4', '5+']

export default function ExportPage({ onNavigate }: { onNavigate?: (page: 'pricing') => void }) {
  const [area, setArea] = useState('')
  const [bedrooms, setBedrooms] = useState('Any')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [psfMin, setPsfMin] = useState('')
  const [psfMax, setPsfMax] = useState('')

  const [preview, setPreview] = useState<Preview | null>(null)
  const [history, setHistory] = useState<ExportEvent[]>([])
  const [blocked, setBlocked] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'csv' | 'excel' | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const timer = useRef<number | null>(null)

  const body = useCallback(
    () => ({
      area: area.trim() || undefined,
      bedrooms: bedrooms === 'Any' ? undefined : bedrooms === '5+' ? 5 : Number(bedrooms),
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      psfMin: psfMin ? Number(psfMin) : undefined,
      psfMax: psfMax ? Number(psfMax) : undefined,
    }),
    [area, bedrooms, dateFrom, dateTo, psfMin, psfMax],
  )

  const load = useCallback(async () => {
    setPreviewing(true)
    setError(null)
    try {
      const res = await authedFetch('/api/sqftlab/export/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body()),
      })
      const b = (await res.json().catch(() => ({}))) as Preview & { error?: string }
      if (res.status === 403) {
        setBlocked(b.error ?? 'Data export requires a Pro plan')
        setPreview(null)
        return
      }
      if (!res.ok) {
        // Surface the server's own words — "No community matches X" is the
        // useful answer, and a generic message would hide it.
        setError(b.error ?? `Request failed (${res.status})`)
        setPreview(null)
        return
      }
      setBlocked(null)
      setPreview(b)
    } catch {
      setError('Could not reach the export service.')
    } finally {
      setPreviewing(false)
    }
  }, [body])

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(load, 350)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [load])

  const loadHistory = useCallback(async () => {
    try {
      const res = await authedFetch('/api/sqftlab/export/history')
      if (!res.ok) return
      const b = (await res.json().catch(() => ({}))) as { exports?: ExportEvent[] }
      setHistory(Array.isArray(b.exports) ? b.exports : [])
    } catch {
      /* history is decorative; never block the page on it */
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  async function download(format: 'csv' | 'excel') {
    setBusy(format)
    setNotice(null)
    setError(null)
    try {
      const res = await authedFetch('/api/sqftlab/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body(), format }),
      })

      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string }
        setError(b.error ?? `Export failed (${res.status})`)
        return
      }

      const rows = res.headers.get('X-Export-Rows')
      const total = res.headers.get('X-Export-Total')
      const truncated = res.headers.get('X-Export-Truncated') === 'true'

      const blob = await res.blob()
      const disposition = res.headers.get('Content-Disposition') ?? ''
      const named = /filename="([^"]+)"/.exec(disposition)?.[1]
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = named ?? `sqftlab-transactions.${format === 'csv' ? 'csv' : 'xlsx'}`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)

      setNotice(
        truncated
          ? `Exported ${rows} of ${total} matching rows. Your plan caps exports at ${preview?.rowLimit.toLocaleString() ?? ''} rows.`
          : `Exported ${rows ?? '0'} row${rows === '1' ? '' : 's'}.`,
      )
      void loadHistory()
    } catch {
      setError('The download could not be started.')
    } finally {
      setBusy(null)
    }
  }

  const field = 'w-full rounded-[12px] px-3 py-2.5 text-[13px] outline-none mono'
  const fieldStyle = { background: 'var(--g3)', border: '1px solid var(--gb)', color: 'var(--ink)' }
  const label = 'block text-[11px] font-semibold uppercase tracking-wide mb-1.5'

  if (blocked) {
    return (
      <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <div className="g2 p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-[14px] p-2.5 shrink-0" style={{ background: 'var(--warn-bg)' }}>
              <Lock size={20} style={{ color: 'var(--warn)' }} />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold" style={{ color: 'var(--ink)' }}>
                Data export needs a Pro plan
              </h1>
              <p className="text-[13px] mt-1 leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                {blocked}
              </p>
              {onNavigate && (
                <button
                  onClick={() => onNavigate('pricing')}
                  className="mt-4 px-4 py-2 rounded-[10px] text-[13px] font-semibold"
                  style={{ background: 'var(--b600)', color: '#fff' }}
                >
                  See plans
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-[900px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
      <div className="flex items-start gap-3 mb-5">
        <div className="rounded-[14px] p-2.5 shrink-0" style={{ background: 'rgba(37,99,235,0.09)' }}>
          <Download size={20} style={{ color: 'var(--b600)' }} />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight" style={{ color: 'var(--ink)' }}>
            Export Transaction Data
          </h1>
          <p className="text-[13px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
            Download DLD transaction records in CSV or Excel format
          </p>
        </div>
      </div>

      <div className="g2 p-4 sm:p-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <label className={label} style={{ color: 'var(--ink-5)' }} htmlFor="ex-area">
              Area / Community
            </label>
            <input
              id="ex-area"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder="e.g. Dubai Marina"
              className={field}
              style={fieldStyle}
            />
          </div>

          <div>
            <label className={label} style={{ color: 'var(--ink-5)' }} htmlFor="ex-beds">
              Bedrooms
            </label>
            <select
              id="ex-beds"
              value={bedrooms}
              onChange={(e) => setBedrooms(e.target.value)}
              className={field}
              style={fieldStyle}
            >
              {BEDROOM_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o === 'Any' ? 'Any' : o === '5+' ? '5+' : `${o} BR`}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={label} style={{ color: 'var(--ink-5)' }} htmlFor="ex-psfmin">
              PSF min (AED)
            </label>
            <input
              id="ex-psfmin"
              type="number"
              inputMode="numeric"
              value={psfMin}
              onChange={(e) => setPsfMin(e.target.value)}
              placeholder="100"
              className={field}
              style={fieldStyle}
            />
          </div>

          <div>
            <label className={label} style={{ color: 'var(--ink-5)' }} htmlFor="ex-from">
              Date from
            </label>
            <input
              id="ex-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className={field}
              style={fieldStyle}
            />
          </div>

          <div>
            <label className={label} style={{ color: 'var(--ink-5)' }} htmlFor="ex-to">
              Date to
            </label>
            <input
              id="ex-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className={field}
              style={fieldStyle}
            />
          </div>

          <div>
            <label className={label} style={{ color: 'var(--ink-5)' }} htmlFor="ex-psfmax">
              PSF max (AED)
            </label>
            <input
              id="ex-psfmax"
              type="number"
              inputMode="numeric"
              value={psfMax}
              onChange={(e) => setPsfMax(e.target.value)}
              placeholder="No limit"
              className={field}
              style={fieldStyle}
            />
          </div>
        </div>

        <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--gb)' }}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <p className="text-[13px]" style={{ color: 'var(--ink-4)' }}>
              {previewing && !preview ? (
                'Counting matching records…'
              ) : preview ? (
                <>
                  Estimated{' '}
                  <span className="mono font-semibold" style={{ color: 'var(--ink)' }}>
                    {preview.total.toLocaleString()}
                  </span>{' '}
                  record{preview.total === 1 ? '' : 's'}
                  {preview.truncated && (
                    <>
                      {' '}
                      · this plan exports the{' '}
                      <span className="mono">{preview.rowLimit.toLocaleString()}</span> most recent
                    </>
                  )}
                </>
              ) : (
                'Adjust the filters above'
              )}
            </p>
            {preview && (
              <p className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                {preview.unlimited ? 'Unlimited rows' : `${preview.rowLimit.toLocaleString()} row limit on your plan`}
              </p>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2.5 mt-3">
              <Info size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
              <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--warn)' }}>
                {error}
              </p>
            </div>
          )}

          {notice && (
            <div className="mt-3 rounded-[10px] px-3 py-2.5" style={{ background: 'var(--g4)' }}>
              <p className="text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
                {notice}
              </p>
            </div>
          )}

          {preview?.empty && !error && (
            <div className="flex items-start gap-2.5 mt-3">
              <Info size={15} className="shrink-0 mt-0.5" style={{ color: 'var(--warn)' }} />
              <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-4)' }}>
                No transactions match these filters. The DLD transaction register behind this export
                holds no rows in this environment, so every filter returns an empty file — the header
                row is written so the download is still valid.
              </p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2.5 mt-4">
            <button
              onClick={() => download('csv')}
              disabled={busy !== null}
              className="flex-1 flex items-center justify-center gap-2 rounded-[10px] px-4 py-2.5 text-[13px] font-semibold transition-opacity"
              style={{ background: 'var(--b600)', color: '#fff', opacity: busy ? 0.6 : 1 }}
            >
              <FileText size={15} />
              {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
            </button>

            <button
              onClick={() => download('excel')}
              disabled={busy !== null || preview?.excelAllowed === false}
              className="flex-1 flex items-center justify-center gap-2 rounded-[10px] px-4 py-2.5 text-[13px] font-semibold transition-opacity"
              style={{
                background: preview?.excelAllowed === false ? 'var(--g4)' : 'var(--ink)',
                color: preview?.excelAllowed === false ? 'var(--ink-5)' : '#fff',
                opacity: busy ? 0.6 : 1,
                cursor: preview?.excelAllowed === false ? 'not-allowed' : 'pointer',
              }}
            >
              <FileSpreadsheet size={15} />
              {busy === 'excel' ? 'Preparing…' : 'Download Excel'}
              {preview?.excelAllowed === false && (
                <span
                  className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold tracking-wide"
                  style={{ background: 'var(--b600)', color: '#fff' }}
                >
                  ENTERPRISE
                </span>
              )}
            </button>
          </div>

          {preview?.excelAllowed === false && (
            <p className="text-[11.5px] mt-2" style={{ color: 'var(--ink-5)' }}>
              Excel export requires the Enterprise plan.{' '}
              {onNavigate && (
                <button
                  onClick={() => onNavigate('pricing')}
                  className="underline font-semibold"
                  style={{ color: 'var(--b600)' }}
                >
                  Upgrade for unlimited rows →
                </button>
              )}
            </p>
          )}
        </div>
      </div>

      {history.length > 0 && (
        <div className="g2 p-4 sm:p-5 mt-4">
          <div className="flex items-center gap-2 mb-3">
            <Clock size={14} style={{ color: 'var(--ink-4)' }} />
            <h2 className="text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
              Recent exports
            </h2>
          </div>
          <div className="space-y-1.5">
            {history.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between gap-3 rounded-[10px] px-3 py-2"
                style={{ background: 'var(--g4)' }}
              >
                <div className="min-w-0">
                  <span className="text-[12.5px] font-medium uppercase" style={{ color: 'var(--ink-3)' }}>
                    {h.eventData?.format ?? 'export'}
                  </span>
                  {h.eventData?.area && (
                    <span className="text-[12px] ml-2" style={{ color: 'var(--ink-4)' }}>
                      {h.eventData.area}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="mono text-[12px]" style={{ color: 'var(--ink-4)' }}>
                    {h.eventData?.rows ?? 0} rows
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--ink-5)' }}>
                    {new Date(h.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
