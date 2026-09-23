import type { ReactNode } from 'react'
import { Lock } from 'lucide-react'
import { handlePaymentAttempt } from '@/lib/payments'

interface FeatureGateProps {
  feature: string
  children: ReactNode
}

// Pro/Elite gate (spec Part 6.3). The real content renders underneath and is
// blurred and made non-interactive, so the shape of what is locked is visible
// but unreadable, and the only CTA routes through the payment kill switch.
export function FeatureGate({ feature, children }: FeatureGateProps) {
  return (
    <div className="relative overflow-hidden rounded-[18px]">
      <div
        aria-hidden="true"
        style={{ filter: 'blur(6px)', userSelect: 'none', pointerEvents: 'none' }}
      >
        {children}
      </div>
      <div
        className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center p-6"
        style={{
          background: 'var(--g2)',
          backdropFilter: 'var(--gblur)',
          WebkitBackdropFilter: 'var(--gblur)',
          border: '1px solid var(--gb)',
        }}
      >
        <Lock size={22} style={{ color: 'var(--b600)' }} />
        <div className="font-semibold text-sm" style={{ color: 'var(--ink)' }}>
          {feature}
        </div>
        <div className="text-xs" style={{ color: 'var(--ink-4)' }}>
          Available on Pro and Elite
        </div>
        <button
          onClick={handlePaymentAttempt}
          className="mt-1 px-4 py-2 rounded-full text-xs font-semibold"
          style={{
            background: 'linear-gradient(90deg,#2563EB,#6366F1)',
            color: '#fff',
            boxShadow: 'var(--sh-btn)',
          }}
        >
          Coming soon
        </button>
      </div>
    </div>
  )
}
