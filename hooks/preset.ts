// A preset: a folder, ~/.sentinel/presets/<name>/, laid out as a project's .sentinel is: library.json (weight, on,
// mcps), instructions/ and flows/. A project points at one and nothing is copied. Pure: the engine reads and writes the
// files; this checks an imported or exported file and works out a move.
import type { FlowDef, InstructionDef, Switches, Weight } from '../types'
import { WEIGHTS } from './builtins.ts'
import { flowOf, instructionOf, withWeight } from './core.ts'

// A preset as one file, for Export and Import.
export type Preset = { name: string; weight?: Weight; on?: Record<string, boolean>; instructions?: InstructionDef[]; flows?: FlowDef[]; mcps?: string[] }

export const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
// The /sentinel preset sub-commands, which can't be names.
const RESERVED = ['new', 'move', 'delete', 'none']

export function presetName(s: string): string | undefined {
  const n = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return PRESET_NAME.test(n) && !RESERVED.includes(n) ? n : undefined
}

const KEYS = ['weight', 'on', 'instructions', 'flows', 'mcps']
const SWITCH_NAME = /^[a-z0-9][a-z0-9-]*$/
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

// A file's content checked. A string says what is wrong.
export function presetOf(raw: unknown, name: string): Preset | string {
  if (!isObj(raw)) return 'A preset is a JSON object.'
  for (const k of Object.keys(raw)) if (k !== 'name' && !KEYS.includes(k)) return `A preset has no "${k}": it holds weight, on, instructions, flows and mcps only.`
  const out: Preset = { name }
  if (raw.weight !== undefined) {
    if (!WEIGHTS.includes(raw.weight as Weight)) return 'weight is light, standard or thorough.'
    out.weight = raw.weight as Weight
  }
  if (raw.on !== undefined) {
    if (!isObj(raw.on)) return 'on is an object of switches: name, true or false.'
    for (const [k, v] of Object.entries(raw.on)) {
      if (!SWITCH_NAME.test(k)) return `Bad switch name "${k}" in on: use lowercase letters, digits and -.`
      if (typeof v !== 'boolean') return `The switch "${k}" in on is true or false.`
    }
    if (Object.keys(raw.on).length) out.on = { ...(raw.on as Record<string, boolean>) }
  }
  const seen = new Set<string>()
  const list = <T extends { name: string }>(key: 'instructions' | 'flows', check: (r: unknown) => T | string): T[] | string => {
    const v = raw[key]
    if (v === undefined) return []
    if (!Array.isArray(v)) return `${key} is a list.`
    const got: T[] = []
    for (const r of v) {
      const d = check(r)
      if (typeof d === 'string') return d
      if (seen.has(d.name)) return `The name "${d.name}" is used twice in this preset.`
      seen.add(d.name)
      got.push(d)
    }
    return got
  }
  const ins = list('instructions', instructionOf)
  if (typeof ins === 'string') return ins
  const flows = list('flows', flowOf)
  if (typeof flows === 'string') return flows
  if (ins.length) out.instructions = ins
  if (flows.length) out.flows = flows
  if (raw.mcps !== undefined) {
    if (!Array.isArray(raw.mcps)) return 'mcps is a list of MCP server names.'
    const got: string[] = []
    for (const m of raw.mcps) {
      const s = typeof m === 'string' ? m.trim() : ''
      if (!s) return 'Each MCP name in mcps is a non-empty string.'
      if (s.length > 100) return `The MCP name "${s.slice(0, 20)}..." is over 100 characters.`
      if (got.some(g => g.toLowerCase() === s.toLowerCase())) return `The MCP "${s}" is listed twice.`
      got.push(s)
    }
    if (got.length) out.mcps = got
  }
  return out
}

// A preset's switches and items as one file. The caller passes the items as their files hold them.
export function presetFrom(sw: Switches, items: { instructions: InstructionDef[]; flows: FlowDef[] }, name: string): Preset {
  return {
    name,
    ...(sw.weight ? { weight: sw.weight } : {}),
    ...(sw.on && Object.keys(sw.on).length ? { on: { ...sw.on } } : {}),
    ...(items.instructions.length ? { instructions: [...items.instructions] } : {}),
    ...(items.flows.length ? { flows: [...items.flows] } : {}),
    ...(sw.mcps?.length ? { mcps: [...sw.mcps] } : {}),
  }
}

// MCP names with one name added once, ignoring case: the first spelling stays.
export const addMcps = (to: readonly string[], more: readonly string[]) => more.reduce((xs, m) => (xs.some(x => x.toLowerCase() === m.toLowerCase()) ? xs : [...xs, m]), [...to])

// A preset's switches with this project's moved in. The project sat above the preset, so its choices win: its weight
// ends the preset's switches on built-ins (as it did from above), and its switches go over the preset's. The MCPs add up.
export function moveInto(preset: Switches, project: Switches, builtins: readonly string[]): Switches {
  const base = project.weight ? withWeight(preset, project.weight, builtins) : preset
  const on = { ...base.on, ...project.on }
  const mcps = addMcps(preset.mcps ?? [], project.mcps ?? [])
  return { ...(base.weight ? { weight: base.weight } : {}), ...(Object.keys(on).length ? { on } : {}), ...(mcps.length ? { mcps } : {}) }
}

// An imported preset's MCPs with the user's choices: another server's name in place of one, or null to leave it out.
export const withSwap = (mcps: readonly string[], swap: Record<string, string | null> = {}) =>
  addMcps([], mcps.flatMap(m => (!Object.hasOwn(swap, m) ? [m] : swap[m] ? [swap[m]!] : [])))
