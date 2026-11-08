// Which of the MCP servers a project needs this session has. A plugin sees a server only through its tools' names,
// mcp__<server>__<tool>, and those spell it their own way: claude.ai Notion comes through as claude_ai_Notion and the
// Playwright plugin's server as plugin_playwright_playwright. So names are squashed to lowercase letters and digits,
// and a name matches a server when it equals the server's whole name or the name without its claude.ai or plugin part.
// Only whole names match, so "note" never stands in for Notion.

export type McpState = { name: string; state: 'connected' | 'sign-in' | 'missing'; server?: string }

// A server that needs signing in offers these two tools and nothing else.
const SIGN_IN = ['authenticate', 'complete_authentication']
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// Each server in a tool list, with its tools.
function serversOf(tools: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const t of tools) {
    const m = /^mcp__(.+?)__(.+)$/.exec(t)
    if (m) out.set(m[1]!, [...(out.get(m[1]!) ?? []), m[2]!])
  }
  return out
}

// The server's own name: without claude_ai_, or without plugin_<plugin>_ (a plugin's name has no underscore).
function ownName(server: string): string {
  const claude = /^claude_ai_(.+)$/.exec(server)
  if (claude) return claude[1]!.replace(/_/g, ' ')
  const plugin = /^plugin_[^_]+_(.+)$/.exec(server)
  return plugin ? plugin[1]! : server
}

const signInOnly = (tools: readonly string[]) => tools.every(t => SIGN_IN.includes(t))

function matches(name: string, server: string): boolean {
  const n = squash(name).replace(/^claudeai/, '')
  return n === squash(server) || n === squash(ownName(server))
}

// Each needed name with its state here. Where two servers match, one with real tools wins over one that only signs in.
export function mcpStates(needed: readonly string[], tools: readonly string[]): McpState[] {
  const servers = [...serversOf(tools)]
  return needed.map(name => {
    const found = servers.filter(([server]) => matches(name, server))
    const ready = found.find(([, t]) => !signInOnly(t))
    if (ready) return { name, state: 'connected', server: ready[0] }
    return found.length ? { name, state: 'sign-in', server: found[0]![0] } : { name, state: 'missing' }
  })
}

// The servers this session has, by the name the page offers, which matches its server again.
export function serverList(tools: readonly string[]): { server: string; name: string; signIn: boolean }[] {
  return [...serversOf(tools)].map(([server, t]) => ({ server, name: ownName(server), signIn: signInOnly(t) }))
}

const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]!)

// What the user reads when a needed server isn't ready, or undefined when all are.
export function mcpProblem(states: readonly McpState[]): string | undefined {
  const missing = states.filter(s => s.state === 'missing').map(s => s.name)
  const signIn = states.filter(s => s.state === 'sign-in').map(s => s.name)
  const parts = [
    ...(missing.length ? [`${listed(missing)} ${missing.length > 1 ? "aren't" : "isn't"} connected in this session`] : []),
    ...(signIn.length ? [`${listed(signIn)} ${signIn.length > 1 ? 'need' : 'needs'} you to sign in`] : []),
  ]
  return parts.length ? `${parts.join(', and ')}.` : undefined
}
