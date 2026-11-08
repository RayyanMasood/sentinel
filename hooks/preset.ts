// A preset: a project's Library setup in one file (~/.sentinel/presets/<name>.json). Pure: the engine reads and writes
// the files, this checks what it read and works out what using a preset changes.
import type { FlowDef, InstructionDef, Switches, Weight } from '../types'
import { WEIGHTS } from './builtins.ts'
import { flowOf, instructionOf, withWeight } from './core.ts'

export type Preset = { name: string; weight?: Weight; on?: Record<string, boolean>; instructions?: InstructionDef[]; flows?: FlowDef[]; mcps?: string[] }

export const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
// The /sentinel preset sub-commands, which can't be names.
const RESERVED = ['save', 'undo', 'delete']

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

// A project's setup as a preset. The caller passes only the items it trusts.
export function presetFrom(project: Switches & { mcps?: string[] }, items: { instructions: InstructionDef[]; flows: FlowDef[] }, name: string): Preset {
  return {
    name,
    ...(project.weight ? { weight: project.weight } : {}),
    ...(project.on && Object.keys(project.on).length ? { on: { ...project.on } } : {}),
    ...(items.instructions.length ? { instructions: [...items.instructions] } : {}),
    ...(items.flows.length ? { flows: [...items.flows] } : {}),
    ...(project.mcps?.length ? { mcps: [...project.mcps] } : {}),
  }
}

export type Applied = { switches: Switches & { mcps?: string[]; preset: string }; add: { instructions: InstructionDef[]; flows: FlowDef[] }; kept: string[]; weightReset: boolean }

// A preset sets only what it names and changes only what differs. A new weight resets the hand-flipped built-ins, as
// picking a weight does. swap: another MCP name in place of a preset's, or null to leave it out.
export function applyPreset(project: Switches & { mcps?: string[]; preset?: string }, p: Preset, o: { builtins: readonly string[]; taken: readonly string[]; swap?: Record<string, string | null> }): Applied {
  const weightReset = !!p.weight && p.weight !== project.weight
  const start: Switches = weightReset ? withWeight(project, p.weight!, o.builtins) : { ...(project.weight ? { weight: project.weight } : {}), ...(project.on ? { on: project.on } : {}) }
  const on = { ...start.on, ...p.on }
  const mcps = [...(project.mcps ?? [])]
  for (const m of p.mcps ?? []) {
    const n = o.swap && Object.hasOwn(o.swap, m) ? o.swap[m] : m
    if (n && !mcps.some(x => x.toLowerCase() === n.toLowerCase())) mcps.push(n)
  }
  const free = (x: { name: string }) => !o.taken.includes(x.name)
  const all = [...(p.instructions ?? []), ...(p.flows ?? [])].map(x => x.name)
  return {
    switches: { ...(start.weight ? { weight: start.weight } : {}), ...(Object.keys(on).length ? { on } : {}), ...(mcps.length ? { mcps } : {}), preset: p.name },
    add: { instructions: (p.instructions ?? []).filter(free), flows: (p.flows ?? []).filter(free) },
    kept: all.filter(n => o.taken.includes(n)),
    weightReset,
  }
}
