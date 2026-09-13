import { useState, useEffect, type ReactNode } from 'react'
import { registerToast } from '@/lib/payments'

interface ToastState {
  message: string
  visible: boolean
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState>({ message: '', visible: false })

  useEffect(() => {
    registerToast((msg: string) => {
      setToast({ message: msg, visible: true })
      setTimeout(() => setToast(t => ({ ...t, visible: false })), 4200)
    })
  }, [])

  return (
    <>
      {children}
      {toast.visible && (
        <div
          className="fixed bottom-7 right-7 z-[9999] flex items-center gap-2.5 px-4 py-3.5 min-w-[300px] max-w-[420px] rounded-[14px] border-l-[3px] border-l-[var(--b600)] font-medium text-sm"
          style={{
            background: 'rgba(255,255,255,0.74)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            border: '1px solid rgba(255,255,255,0.92)',
            boxShadow: '0 2px 8px rgba(15,23,42,0.07), 0 8px 32px rgba(15,23,42,0.05)',
            animation: 'toast-in 280ms var(--ease)',
          }}
          role="alert"
          aria-live="polite"
        >
          <span className="text-[var(--b600)] text-base">◉</span>
          <span className="text-[var(--ink-2)] flex-1">{toast.message}</span>
          <button
            onClick={() => setToast(t => ({ ...t, visible: false }))}
            className="bg-transparent border-none cursor-pointer text-[var(--ink-5)] text-lg leading-none p-0 hover:text-[var(--ink-3)] transition-colors"
            aria-label="Dismiss"
          >×</button>
        </div>
      )}
    </>
  )
}
