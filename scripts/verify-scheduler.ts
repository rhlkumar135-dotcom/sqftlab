#!/usr/bin/env bun
/**
 * Prove the boot tasks behave: the admin account is reproducible, and the data pipelines
 * run without any external caller.
 *
 * The claim being tested is "the deployment keeps itself current". The cron routes are
 * HTTP endpoints and nothing on this deployment calls them, so the meaningful question is
 * not whether the endpoints work — it is whether anything fires them. That is what the
 * timed section below actually exercises: start the scheduler, wait past its kickoff, and
 * assert a job ran.
 *
 * Runs against a copy of the database so the admin checks cannot touch real accounts.
 *
 * Usage:
 *   cp prisma/dev.db /tmp/scheduler-e2e.db
 *   DATABASE_URL=file:/tmp/scheduler-e2e.db bun run scripts/verify-scheduler.ts
 */
const url = process.env.DATABASE_URL ?? ''
if (!url.includes('scheduler-e2e')) {
  console.error(
    'Refusing to run: set DATABASE_URL to a scheduler-e2e copy.\n' +
      '  cp prisma/dev.db /tmp/scheduler-e2e.db\n' +
      '  DATABASE_URL=file:/tmp/scheduler-e2e.db bun run scripts/verify-scheduler.ts',
  )
  process.exit(1)
}

const { startScheduler, stopScheduler, schedulerInfo, schedulerEnabled } = await import('../src/lib/scheduler')
const { ensureAdminUser } = await import('../src/lib/admin-bootstrap')
const { prisma } = await import('../src/lib/db')
const { hashPassword, verifyPassword } = await import('../src/lib/passwords')

let passed = 0
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failures.push(label)
    console.log(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const ADMIN_EMAIL = 'verify-admin@scheduler-e2e.test'
const NONADMIN_EMAIL = 'verify-nonadmin@scheduler-e2e.test'
const ADMIN_PASSWORD = 'verify-Admin-Pw-123456'
const ORIGINAL_PASSWORD = 'original-pw-9876'

console.log('\n── admin bootstrap ──')
{
  await prisma.user.deleteMany({ where: { email: { in: [ADMIN_EMAIL, NONADMIN_EMAIL] } } })

  delete process.env.ADMIN_EMAIL
  delete process.env.ADMIN_PASSWORD
  let r = await ensureAdminUser()
  check('no ADMIN_EMAIL means no account is invented', r.action === 'unconfigured', r)

  process.env.ADMIN_EMAIL = ADMIN_EMAIL
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD
  r = await ensureAdminUser()
  check('a configured admin is created', r.action === 'created', r)

  const created = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } })
  check('the created account is an admin', created?.isAdmin === true)
  check(
    'the configured password actually verifies',
    created?.passwordHash ? await verifyPassword(ADMIN_PASSWORD, created.passwordHash) : false,
  )

  r = await ensureAdminUser()
  check('a second boot does not duplicate the account', r.action === 'present', r)
  check('exactly one account exists for the address', (await prisma.user.count({ where: { email: ADMIN_EMAIL } })) === 1)

  // A real account that merely lacks the flag must be promoted — never recreated, and its
  // password must survive. A silent reset here would lock out a working credential.
  const other = await prisma.user.create({
    data: { email: NONADMIN_EMAIL, name: 'Verify NonAdmin', passwordHash: await hashPassword(ORIGINAL_PASSWORD) },
  })
  process.env.ADMIN_EMAIL = NONADMIN_EMAIL
  process.env.ADMIN_PASSWORD = 'a-different-pw-1234'
  r = await ensureAdminUser()
  check('an existing account is promoted, not recreated', r.action === 'promoted', r)

  const after = await prisma.user.findUnique({ where: { id: other.id } })
  check('promotion grants the admin flag', after?.isAdmin === true)
  check(
    'promotion does not reset the existing password',
    after?.passwordHash ? await verifyPassword(ORIGINAL_PASSWORD, after.passwordHash) : false,
  )
  check(
    'the bootstrap password is NOT applied to an existing account',
    after?.passwordHash ? !(await verifyPassword('a-different-pw-1234', after.passwordHash)) : false,
  )

  await prisma.user.deleteMany({ where: { email: { in: [ADMIN_EMAIL, NONADMIN_EMAIL] } } })
  delete process.env.ADMIN_EMAIL
  delete process.env.ADMIN_PASSWORD
}

console.log('\n── scheduler gating ──')
{
  const saved = { node: process.env.NODE_ENV, on: process.env.ENABLE_INPROCESS_CRON, off: process.env.DISABLE_INPROCESS_CRON }
  delete process.env.NODE_ENV
  delete process.env.ENABLE_INPROCESS_CRON
  delete process.env.DISABLE_INPROCESS_CRON

  check('off outside production, so a dev process does not fight the developer', schedulerEnabled() === false)

  process.env.ENABLE_INPROCESS_CRON = 'true'
  check('an explicit flag turns it on', schedulerEnabled() === true)

  process.env.DISABLE_INPROCESS_CRON = 'true'
  check('an explicit disable overrides the enable', schedulerEnabled() === false)

  process.env.NODE_ENV = 'production'
  delete process.env.ENABLE_INPROCESS_CRON
  delete process.env.DISABLE_INPROCESS_CRON
  check('production is on by default', schedulerEnabled() === true)

  if (saved.node === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = saved.node
  if (saved.on !== undefined) process.env.ENABLE_INPROCESS_CRON = saved.on
  if (saved.off !== undefined) process.env.DISABLE_INPROCESS_CRON = saved.off

  process.env.ENABLE_INPROCESS_CRON = 'true'
  delete process.env.DISABLE_INPROCESS_CRON
}

console.log('\n── scheduler registration ──')
{
  const info = startScheduler()
  check('the scheduler starts', info.started === true, info.started)
  check('three pipelines are scheduled', info.jobs.length === 3, info.jobs.map((j) => j.job))
  check(
    'every job has an interval',
    info.jobs.every((j) => typeof j.intervalMs === 'number'),
    info.jobs.map((j) => `${j.job}=${j.intervalMs}`),
  )
  check(
    'the news ingest runs every 30 minutes',
    info.jobs.find((j) => j.job === 'news-ingest')?.intervalMs === 30 * 60 * 1000,
  )

  const again = startScheduler()
  // 1 kickoff timeout + 3 intervals. A second start must not add more.
  check(
    'starting twice does not double-schedule',
    info.timerCount === 4 && again.timerCount === 4,
    { first: info.timerCount, second: again.timerCount },
  )
}

console.log('\n── the pipelines actually fire (waits past the 30s kickoff) ──')
{
  await new Promise((resolve) => setTimeout(resolve, 36_000))
  const info = schedulerInfo()
  const hourly = info.jobs.find((j) => j.job === 'hourly-refresh')
  check(
    'the hourly refresh fired with no external caller',
    (hourly?.state?.runs ?? 0) >= 1,
    hourly?.state ?? null,
  )
  check(
    'a fired job records when it started',
    typeof hourly?.state?.lastStartedAt === 'string',
    hourly?.state?.lastStartedAt ?? null,
  )

  stopScheduler()
  check('stopping clears the timers', schedulerInfo().timerCount === 0 && schedulerInfo().started === false)
}

await prisma.$disconnect()

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
process.exit(0)
