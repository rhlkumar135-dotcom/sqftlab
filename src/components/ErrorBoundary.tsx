import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Day 15 Task D5 — section-level error boundary.
 *
 * Distinct from `src/ShogoErrorBoundary.tsx`, which wraps the whole canvas app and
 * reports crashes to the host frame. This one wraps an individual *section* so one bad
 * render — a chart fed a malformed payload, say — cannot blank the page around it. The
 * two do not overlap: that boundary is the app's last line of defence, this is
 * containment for a known-fragile child.
 *
 * `resetKeys` re-arms the boundary when its input changes. Without it, React keeps
 * `hasError` forever: a chart that threw once would show the fallback even after the
 * data it choked on is replaced by a fresh fetch, which reads as "this feature is
 * broken" for the rest of the session.
 */

interface Props {
  children: ReactNode
  /** Rendered instead of `children` after a throw. */
  fallback?: ReactNode
  /** Human name for the section, used in the default fallback. */
  label?: string
  /** When any value here changes, the boundary forgets the error and retries. */
  resetKeys?: unknown[]
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true }
  }

  componentDidUpdate(prev: Props) {
    if (!this.state.hasError) return
    const a = prev.resetKeys ?? []
    const b = this.props.resetKeys ?? []
    if (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))) {
      this.setState({ hasError: false })
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Logged rather than swallowed: the fallback tells the user nothing about why, so
    // the console is the only place the cause survives.
    console.error(`[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ''}]`, error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div
            role="alert"
            className="p-4 rounded-[14px] text-sm"
            style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca' }}
          >
            {this.props.label ? `Could not display ${this.props.label}.` : 'Something went wrong loading this section.'}{' '}
            Please refresh.
          </div>
        )
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
