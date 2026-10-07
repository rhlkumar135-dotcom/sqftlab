import type { ReactNode } from 'react'

/**
 * One empty/denied state for every screen, so they cannot drift apart.
 *
 * Day 15 Task B asked for a new `src/components/EmptyState.tsx`. One already existed —
 * inline in App.tsx and already used by four screens — so this is that component MOVED,
 * not a second copy. The brief's body used inline styles and a string emoji for the
 * icon; this keeps the design tokens (`--ink`, `--b700`) and a `ReactNode` icon so it
 * renders the same icon set as the rest of the app.
 *
 * `action` is a callback rather than the brief's `href`: navigation here is in-app, and
 * the hrefs the brief used are not paths this app publishes.
 */
export function EmptyState({ icon, title, body, action }: {
  icon: ReactNode
  title: string
  body: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="text-center py-16 px-6 max-w-[560px] mx-auto">
      <div className="mx-auto mb-3 flex justify-center" style={{ color: 'var(--ink-6)' }}>{icon}</div>
      <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--ink)' }}>{title}</h3>
      <p className="text-sm mb-5" style={{ color: 'var(--ink-4)' }}>{body}</p>
      {action && (
        <button onClick={action.onClick} className="px-5 py-2.5 rounded-xl text-sm font-semibold"
          style={{ background: 'var(--b700)', color: '#fff' }}>{action.label}</button>
      )}
    </div>
  )
}

export default EmptyState
