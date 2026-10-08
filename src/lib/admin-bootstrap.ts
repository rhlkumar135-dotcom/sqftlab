/**
 * Ensure the operator account exists, on every boot.
 *
 * Admin access was created by hand in a previous session, which makes it a fact about one
 * database at one moment rather than a property of the deployment: a fresh environment, a
 * restored backup or a rotated database all come up with no admin, and the only way back
 * in is another manual session. Driving it from `ADMIN_EMAIL` + `ADMIN_PASSWORD` makes the
 * account reproducible — it exists wherever those two variables are set.
 *
 * Deliberately does NOT reset the password of an account that already exists. A silent
 * reset on boot would invalidate a working credential the operator may be using, and would
 * do it again on every deploy. Rotating is an explicit act: change the variable and delete
 * the row, or promote deliberately.
 */
import { prisma } from './db'
import { hashPassword } from './passwords'

export type AdminBootstrapAction = 'created' | 'promoted' | 'present' | 'unconfigured' | 'failed'

export interface AdminBootstrapResult {
  action: AdminBootstrapAction
  email: string | null
  detail?: string
}

export async function ensureAdminUser(): Promise<AdminBootstrapResult> {
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD ?? ''

  if (email === '' || password === '') {
    // Not an error: an operator who has not set these has an admin account created some
    // other way, and inventing one with a password nobody knows would be worse.
    return { action: 'unconfigured', email: email === '' ? null : email }
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      if (existing.isAdmin) return { action: 'present', email }
      await prisma.user.update({ where: { id: existing.id }, data: { isAdmin: true } })
      return { action: 'promoted', email, detail: 'existing account granted admin' }
    }

    await prisma.user.create({
      data: {
        email,
        name: 'Administrator',
        passwordHash: await hashPassword(password),
        isAdmin: true,
        registeredVia: 'password',
        // The operator is not a new signup: leaving these false would put an admin
        // through the onboarding tour on first login.
        onboardingCompleted: true,
        tourCompleted: true,
        subscriptionStatus: 'active',
      },
    })
    return { action: 'created', email }
  } catch (e) {
    // A bootstrap failure must not stop the server — the app is still usable, and the
    // admin may well already exist.
    return { action: 'failed', email, detail: e instanceof Error ? e.message : String(e) }
  }
}
