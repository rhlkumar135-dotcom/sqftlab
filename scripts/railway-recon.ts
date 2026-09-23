#!/usr/bin/env bun
// Read-only Railway reconnaissance. Lists what a token can see so we can confirm
// the sqftlab target BEFORE anything is deployed. Never mutates anything.
const token = process.env.RAILWAY_TOKEN
if (!token) {
  console.error('RAILWAY_TOKEN is not set — export it and re-run.')
  process.exit(2)
}

const ENDPOINT = 'https://backboard.railway.app/graphql/v2'

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const me = await gql('query { me { id name email } }')
if (me.body?.errors?.length || !me.body?.data?.me) {
  console.error('Token rejected by Railway:', JSON.stringify(me.body?.errors ?? me.body))
  process.exit(1)
}
console.log(`Authenticated as: ${me.body.data.me.name ?? me.body.data.me.email}`)

const projects = await gql(`
  query {
    projects {
      edges {
        node {
          id
          name
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
        }
      }
    }
  }
`)

if (projects.body?.errors?.length) {
  console.error('Could not list projects:', JSON.stringify(projects.body.errors))
  process.exit(1)
}

const list = projects.body?.data?.projects?.edges ?? []
console.log(`\nAccessible projects (${list.length}):\n`)
for (const { node: p } of list) {
  const envs = (p.environments?.edges ?? []).map((e: any) => e.node.name).join(', ') || '—'
  const svcs = (p.services?.edges ?? []).map((s: any) => s.node.name).join(', ') || '—'
  console.log(`  ${p.name}  (id ${p.id})`)
  console.log(`     environments: ${envs}`)
  console.log(`     services:     ${svcs}`)
}

const sqft = list.find((e: any) => /sqft/i.test(e.node.name))
console.log('\n--- plan (no mutation performed) ---')
if (sqft) {
  console.log(`sqftlab target found: ${sqft.node.name} (id ${sqft.node.id})`)
  console.log('Services:')
  for (const s of sqft.node.services?.edges ?? []) console.log(`  - ${s.node.name} (id ${s.node.id})`)
  console.log('Environments:')
  for (const e of sqft.node.environments?.edges ?? []) console.log(`  - ${e.node.name} (id ${e.node.id})`)
} else {
  console.log('No project matching /sqft/ visible to this token.')
}
const offLimits = list.filter((e: any) => /crude|crudepulse/i.test(e.node.name))
if (offLimits.length) console.log(`\nTOUCH NOTHING: ${offLimits.map((o: any) => o.node.name).join(', ')}`)
