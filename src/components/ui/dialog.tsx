import { useState, useEffect, useId, createContext, useContext, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { X } from 'lucide-react'

/**
 * Minimal modal dialog.
 *
 * Day 17: gained `role="dialog"`, `aria-modal`, `aria-labelledby` and Escape-to-close.
 * Without them this was a `<div>` that merely looked like a dialog — a screen reader had
 * no way to announce it as a modal, no way to know what it was for, and the only way out
 * was to find the close button with a mouse. `titleId` is generated per Dialog and shared
 * through context so `DialogTitle` can label the content it belongs to.
 */
interface DialogContextValue {
  open: boolean
  setOpen: (v: boolean) => void
  titleId: string
}

const DialogContext = createContext<DialogContextValue>({
  open: false,
  setOpen: () => {},
  titleId: '',
})

interface DialogProps {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  children?: ReactNode
}

export function Dialog({ open: controlledOpen, defaultOpen = false, onOpenChange, children }: DialogProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const titleId = useId()
  const open = controlledOpen ?? internalOpen
  const setOpen = (v: boolean) => {
    setInternalOpen(v)
    onOpenChange?.(v)
  }

  return (
    <DialogContext.Provider value={{ open, setOpen, titleId }}>
      {children}
    </DialogContext.Provider>
  )
}

export function DialogTrigger({ children, className, ...props }: HTMLAttributes<HTMLButtonElement>) {
  const { setOpen } = useContext(DialogContext)
  return (
    <button className={className} onClick={() => setOpen(true)} {...props}>
      {children}
    </button>
  )
}

export function DialogContent({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const { open, setOpen, titleId } = useContext(DialogContext)

  // Escape closes. Registered only while open, so several closed dialogs on a page do not
  // each hold a listener.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50" onClick={() => setOpen(false)} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'relative z-50 grid w-full max-w-lg gap-4 rounded-lg border bg-background p-6 shadow-lg',
          className,
        )}
        {...props}
      >
        {children}
        <button
          className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100"
          onClick={() => setOpen(false)}
          aria-label="Close dialog"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 text-center sm:text-left', className)} {...props} />
}

export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  const { titleId } = useContext(DialogContext)
  return <h2 id={titleId} className={cn('text-lg font-semibold leading-none tracking-tight', className)} {...props} />
}

export function DialogDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted-foreground', className)} {...props} />
}

export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
}
