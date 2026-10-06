#!/usr/bin/env node
// WP0 of docs/analysis/backends-design.md: re-measure GitHub Copilot CLI 1.0.91.
// OPT-IN. Not an e2e (run-e2e.mjs globs e2e-*.mjs), never part of `npm test`. Spends real prompts (<= 5).
//
//   node scripts/probe-copilot-1091.mjs [stage ...]      stages: setup schema models run   (default: all)
//
// Safety, in the order it matters:
//  - everything lives under SCRATCH (override WP0_SCRATCH); cwd of the CLI is a throwaway git repo there.
//  - tmux sessions are named spike_cp91_* ONLY and every tmux call goes through tm(), which refuses any
//    other session name. waterplane_* sessions are the user's live ones and are never touched.
//  - COPILOT_AUTO_UPDATE=false on every spawn. Hooks come ONLY from a --plugin-dir plugin in SCRATCH;
//    ~/.copilot/config.json and settings.json are never written.
//  - the `run` stage aborts BEFORE any prompt unless the model list proves a model that costs 0 premium
//    requests (or `--allow-auto` is passed after the human looked at what Auto costs).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'

const SCRATCH = process.env.WP0_SCRATCH || path.join(os.tmpdir(), 'wp0-copilot')
const REPO = path.join(SCRATCH, 'repo')
const PLUGIN = path.join(SCRATCH, 'plugin')
const OUT = path.join(SCRATCH, 'out')
const CACHE = path.join(os.homedir(), 'Library/Caches/copilot/pkg/universal')
const SESSIONS = path.join(os.homedir(), '.copilot/session-state')
const COPILOT = process.env.WP0_COPILOT || 'copilot'
const PREFIX = 'spike_cp91_'
const args = process.argv.slice(2)
const ALLOW_AUTO = args.includes('--allow-auto')
const stages = args.filter((a) => !a.startsWith('--'))
const want = (s) => stages.length === 0 || stages.includes(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)
const wr = (f, s) => fs.writeFileSync(path.join(OUT, f), typeof s === 'string' ? s : JSON.stringify(s, null, 2))
const readJsonl = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { unparsed: l } } })
  } catch { return [] }
}
let promptsSent = 0
const PROMPT_CAP = 3

// ---------------------------------------------------------------- tmux (guarded)
function tm(...a) {
  if (a[0] === 'list-sessions') return execFileSync('tmux', a, { encoding: 'utf8' }) // read-only listing
  const i = a.indexOf('-t')
  const name = i >= 0 ? a[i + 1] : a[a.indexOf('-s') + 1]
  if (!String(name).startsWith(PREFIX)) throw new Error(`refusing tmux on non-probe session ${name}`)
  return execFileSync('tmux', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}
const screen = (s) => { try { return tm('capture-pane', '-p', '-t', s) } catch { return '' } }
const keys = (s, ...k) => tm('send-keys', '-t', s, ...k)
const alive = (s) => { try { tm('has-session', '-t', s); return true } catch { return false } }
const env = (extra = {}) => ({ COPILOT_AUTO_UPDATE: 'false', ...extra })
function start(name, copilotArgs, extraEnv = {}) {
  const e = Object.entries(env(extraEnv)).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
  const cmd = `env ${e} ${COPILOT} ${copilotArgs.join(' ')}`
  tm('new-session', '-d', '-s', name, '-x', '100', '-y', '40', '-c', REPO, cmd)
}
async function waitFor(what, fn, timeoutMs = 90000, stepMs = 500) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn()
    if (v) return v
    await sleep(stepMs)
  }
  return null
}
// trust dialog -> Enter on "1. Yes" (this session only, writes no config); then wait for the input box.
async function boot(name) {
  const ok = await waitFor('trust-or-ready', () => {
    const s = screen(name)
    if (/Confirm folder trust/.test(s)) { keys(name, 'Enter'); return 'trusted' }
    if (/^❯ ?$/m.test(s) && /Manual Approval|Interactive/.test(s)) return 'ready'
    if (/Install it now|Update available|update now/i.test(s)) throw new Error('update prompt on screen: refusing\n' + s)
    return null
  }, 60000)
  if (ok === 'trusted') await waitFor('ready', () => /^❯ ?$/m.test(screen(name)), 60000)
}
async function sendLine(name, text) {
  keys(name, '-l', text)
  await sleep(400)
  keys(name, 'Enter')
}
async function prompt(name, text) {
  if (promptsSent >= PROMPT_CAP) throw new Error('prompt cap reached')
  promptsSent++
  log(`PROMPT ${promptsSent}/${PROMPT_CAP}:`, text)
  await sendLine(name, text)
}
const hooks = () => readJsonl(path.join(OUT, 'hooks.jsonl'))
const hookCount = (ev, phase = 'start') => hooks().filter((h) => h.ev === ev && h.phase === phase).length
const sessDir = (id) => path.join(SESSIONS, id)
const eventsOf = (id) => readJsonl(path.join(sessDir(id), 'events.jsonl'))

// ---------------------------------------------------------------- setup
function setup() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.mkdirSync(REPO, { recursive: true })
  fs.mkdirSync(PLUGIN, { recursive: true })
  if (!fs.existsSync(path.join(REPO, '.git'))) {
    execFileSync('git', ['init', '-q'], { cwd: REPO })
    fs.writeFileSync(path.join(REPO, 'a.txt'), 'hi\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: REPO })
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a'], { cwd: REPO })
  }
  fs.writeFileSync(path.join(PLUGIN, 'plugin.json'), JSON.stringify({ name: 'wp0probe', version: '0.0.1' }))
  const names = ['sessionStart', 'sessionEnd', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'postToolUseFailure',
    'errorOccurred', 'agentStop', 'subagentStop', 'subagentStart', 'preCompact', 'permissionRequest', 'notification']
  const h = {}
  for (const n of names) {
    h[n] = [{ type: 'command', bash: `node ${path.join(PLUGIN, 'hook-rec.mjs')} ${n}`, timeoutSec: n === 'permissionRequest' ? 5 : 10 }]
  }
  fs.writeFileSync(path.join(PLUGIN, 'hooks.json'), JSON.stringify({ version: 1, hooks: h }, null, 1))
  // hook-rec.mjs is checked in beside the scratch plugin (it is not part of the repo): written here so the
  // script is self-contained.
  fs.writeFileSync(path.join(PLUGIN, 'hook-rec.mjs'), `import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(dir, '..', 'out', 'hooks.jsonl')
const ev = process.argv[2]
let raw = ''
process.stdin.on('data', (d) => (raw += d))
process.stdin.on('end', async () => {
  let payload
  try { payload = JSON.parse(raw) } catch { payload = { unparsed: raw } }
  const rec = { ev, pid: process.pid, t0: Date.now(), payload }
  const log = (extra) => fs.appendFileSync(out, JSON.stringify({ ...rec, ...extra }) + '\\n')
  log({ phase: 'start' })
  let hold = 0
  if (ev === 'permissionRequest') { try { hold = Number(fs.readFileSync(path.join(dir, 'hold-secs'), 'utf8')) || 0 } catch {} }
  if (hold > 0) {
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { log({ phase: 'killed', signal: s, t1: Date.now() }); process.exit(143) })
    await new Promise((r) => setTimeout(r, hold * 1000))
  }
  let mode = ''
  if (ev === 'permissionRequest') { try { mode = fs.readFileSync(path.join(dir, 'hold-mode'), 'utf8').trim() } catch {} }
  log({ phase: 'end', t1: Date.now(), held: hold, mode })
  if (mode === 'allow') process.stdout.write(JSON.stringify({ behavior: 'allow' }))
  process.exit(0)
})
`)
  log('setup ok', SCRATCH)
}

// ---------------------------------------------------------------- schema diff 1.0.44 vs 1.0.91
function schemaDiff() {
  const ld = (v) => {
    // 1.0.44 is a universal (JS) pkg; 1.0.91 ships as a native darwin-arm64 pkg
    for (const d of ['universal', 'darwin-arm64']) {
      const f = path.join(CACHE, '..', d, v, 'schemas/session-events.schema.json')
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'))
    }
    throw new Error('no schema for ' + v)
  }
  // events = definitions.SessionEvent.anyOf[].$ref -> def with properties.type.const and properties.data
  const index = (s) => {
    const defs = s.definitions
    const res = (n) => (n && n.$ref ? defs[n.$ref.split('/').pop()] : n)
    const o = {}
    for (const r of defs.SessionEvent.anyOf) {
      const ev = res(r)
      const t = ev.properties.type.const
      const data = res(ev.properties.data) ?? {}
      o[t] = { ephemeral: ev.properties.ephemeral?.const === true, fields: data.properties ?? {}, required: data.required ?? [] }
    }
    return o
  }
  const a = index(ld('1.0.44')), b = index(ld('1.0.91'))
  const ak = Object.keys(a), bk = Object.keys(b)
  const changed = {}
  for (const k of ak.filter((k) => b[k])) {
    const pa = Object.keys(a[k].fields), pb = Object.keys(b[k].fields)
    const added = pb.filter((x) => !pa.includes(x)), removed = pa.filter((x) => !pb.includes(x))
    const eph = a[k].ephemeral !== b[k].ephemeral
    if (added.length || removed.length || eph) changed[k] = { added, removed, ...(eph ? { ephemeralChanged: [a[k].ephemeral, b[k].ephemeral] } : {}) }
  }
  const ty = (v) => (v.type ?? (v.enum ? 'enum' : v.const !== undefined ? 'const:' + v.const : v.$ref ? 'ref' : v.anyOf ? 'anyOf' : '?'))
  const shape = (k, idx) => Object.fromEntries(Object.entries(idx[k]?.fields ?? {}).map(([f, v]) => [f, ty(v)]))
  const keyEvents = ['permission.requested', 'permission.completed', 'session.start', 'session.resume', 'session.shutdown', 'assistant.message', 'assistant.turn_start', 'assistant.turn_end', 'user.message', 'tool.execution_start', 'tool.execution_complete', 'hook.start', 'hook.end', 'session.idle', 'assistant.idle', 'session.usage_info', 'session.usage_checkpoint', 'assistant.usage', 'model.call_start', 'model.call_finished']
  const res = {
    count44: ak.length, count91: bk.length,
    added: bk.filter((k) => !a[k]), removed: ak.filter((k) => !b[k]), changed,
    ephemeral44: ak.filter((k) => a[k].ephemeral), ephemeral91: bk.filter((k) => b[k].ephemeral),
    shapes91: Object.fromEntries(keyEvents.map((k) => [k, { ephemeral: b[k]?.ephemeral, required: b[k]?.required, fields: shape(k, b) }])),
    shapes44: Object.fromEntries(keyEvents.filter((k) => a[k]).map((k) => [k, shape(k, a)])),
  }
  wr('schema-diff.json', res)
  log('schema', res.count44, '->', res.count91, 'added', res.added.length, 'removed', res.removed.length, 'changed', Object.keys(changed).length)
  return res
}

// ---------------------------------------------------------------- model list via ACP (no prompt spent)
async function acpModels() {
  const p = spawn(COPILOT, ['--acp'], { cwd: REPO, env: { ...process.env, ...env() }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1)
      try { const m = JSON.parse(l); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } } catch {}
    }
  })
  let id = 0
  const rpc = (method, params) => new Promise((res, rej) => {
    const n = ++id
    pending.set(n, res)
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
    setTimeout(() => rej(new Error('acp timeout ' + method)), 30000)
  })
  try {
    const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const sn = await rpc('session/new', { cwd: REPO, mcpServers: [] })
    wr('acp-initialize.json', init)
    wr('acp-session-new.json', sn)
    return { init, sn }
  } finally { p.kill() }
}

// ---------------------------------------------------------------- what can be measured with ZERO prompts
// (no model call is made: launch, slash commands that are local, exit, relaunch).
async function noPromptSubset() {
  const uuid = crypto.randomUUID()
  const T = PREFIX + 'n'
  const base = ['--plugin-dir', PLUGIN]
  const notes = { uuid, promptsSent: 0, mode: 'no-prompt subset (no 0x model on this account)' }
  try {
    // 1. --session-id=<fresh uuid> mints
    start(T, [`--session-id=${uuid}`, ...base], { COPILOT_OTEL_FILE_EXPORTER_PATH: path.join(OUT, 'otel-n.jsonl') })
    await boot(T)
    await sleep(2000)
    const idle = screen(T)
    wr('screen-idle.txt', idle)
    notes.sessionDirAtLaunch = fs.existsSync(sessDir(uuid))
    const ev0 = eventsOf(uuid)
    notes.eventsAtLaunch = ev0.map((e) => e.type)
    notes.startEvent = ev0.find((e) => e.type === 'session.start')?.data
    notes.workspaceYaml = fs.existsSync(path.join(sessDir(uuid), 'workspace.yaml')) ? fs.readFileSync(path.join(sessDir(uuid), 'workspace.yaml'), 'utf8') : null
    notes.lockFiles = fs.existsSync(sessDir(uuid)) ? fs.readdirSync(sessDir(uuid)).filter((f) => f.startsWith('inuse.')) : []
    notes.hookStartsAtLaunch = hooks().map((h) => h.ev + ':' + h.phase)
    notes.pluginBannerSeen = /hook|plugin/i.test(idle)
    // 2. where does the screen show context / usage besides /context? (footer, sidebar)
    keys(T, 'Left'); await sleep(1500); wr('screen-sidebar.txt', screen(T)); keys(T, 'Right'); await sleep(800)
    await sendLine(T, '/context'); await sleep(3000); wr('screen-context.txt', screen(T))
    await sendLine(T, '/usage'); await sleep(3000); wr('screen-usage.txt', screen(T))
    await sendLine(T, '/env'); await sleep(3000); wr('screen-env.txt', screen(T)) // lists loaded hooks/plugins
    notes.eventsAfterSlash = eventsOf(uuid).length
    await sendLine(T, '/exit')
    await waitFor('exit', () => !alive(T), 20000)
    await waitFor('shutdown', () => eventsOf(uuid).some((e) => e.type === 'session.shutdown'), 30000)
    await sleep(6000)
    notes.lockGoneAfterExit = !(fs.existsSync(sessDir(uuid)) && fs.readdirSync(sessDir(uuid)).some((f) => f.startsWith('inuse.')))
    notes.eventTypes = eventsOf(uuid).map((e) => e.type)
    notes.shutdown = eventsOf(uuid).find((e) => e.type === 'session.shutdown')?.data
    // 3. --session-id=<existing>: resume or create?
    start(T, [`--session-id=${uuid}`, ...base])
    await boot(T)
    await sleep(2500)
    wr('screen-sessionid-again.txt', screen(T))
    notes.sessionStartEventsAfterSessionIdAgain = eventsOf(uuid).filter((e) => e.type === 'session.start' || e.type === 'session.resume').map((e) => e.type)
    await sendLine(T, '/exit')
    await waitFor('exit2', () => !alive(T), 20000)
    await sleep(3000)
    // 4. --resume=<uuid> of a session that never had a prompt (no events.jsonl)
    notes.eventsFileExistsAfterNoPrompt = fs.existsSync(path.join(sessDir(uuid), 'events.jsonl'))
    start(T, [`--resume=${uuid}`, ...base])
    await sleep(6000)
    notes.resumeEmptyAlive = alive(T)
    wr('screen-resume.txt', screen(T))
    if (alive(T)) { await sendLine(T, '/exit'); await waitFor('exit3', () => !alive(T), 20000) }
    await sleep(2000)
    // 5. --resume=<unknown uuid>
    start(T, [`--resume=${crypto.randomUUID()}`, ...base])
    await sleep(6000)
    notes.resumeUnknownAlive = alive(T)
    wr('screen-resume-unknown.txt', screen(T))
  } finally {
    if (alive(T)) { try { tm('kill-session', '-t', T) } catch {} }
  }
  wr('notes-noprompt.json', notes)
  const ev = eventsOf(uuid)
  fs.writeFileSync(path.join(OUT, 'events-1091.jsonl'), ev.map((e) => JSON.stringify(trim(e))).join('\n') + '\n')
  log('no-prompt subset done', JSON.stringify(notes).slice(0, 800))
}

// ---------------------------------------------------------------- the measured run
async function run(models) {
  // GATE: a model that costs 0 premium requests, proven by ACP _meta.copilotUsage. No such row => abort in words.
  const list = models?.sn?.result?.models?.availableModels ?? models?.sn?.result?.models ?? []
  const rows = (Array.isArray(list) ? list : []).map((m) => ({ id: m.modelId ?? m.id, name: m.name, usage: m._meta?.copilotUsage }))
  const zero = rows.filter((r) => /^0(\.0+)?x?$/i.test(String(r.usage ?? '').trim()))
  wr('model-rows.json', rows)
  const cur = models?.sn?.result?.models?.currentModelId
  let model = null
  if (zero.length) model = zero.find((r) => r.id === cur)?.id ?? zero[0].id
  else if (ALLOW_AUTO) model = null
  else {
    wr('ABORT.txt', 'No model with copilotUsage 0x on this account; no prompt was sent.\n' + JSON.stringify(rows, null, 1))
    log('ABORT: no 0x model; no prompt sent. Running the zero-prompt subset only.')
    await noPromptSubset()
    return
  }
  log('model:', model ?? '(Auto, --allow-auto)')

  const uuid = crypto.randomUUID()
  const otel = (n) => path.join(OUT, `otel-${n}.jsonl`)
  const base = ['--plugin-dir', PLUGIN, ...(model ? ['--model', model] : [])]
  fs.writeFileSync(path.join(PLUGIN, 'hold-secs'), '0')
  const T = PREFIX + 'a'
  const notes = { uuid, model }
  try {
    // ---- 1. --session-id mints; prompt 1 (no tools): agentStop once, events, OTel
    start(T, [`--session-id=${uuid}`, ...base], { COPILOT_OTEL_FILE_EXPORTER_PATH: otel('a') })
    await boot(T)
    notes.sessionDirAtLaunch = fs.existsSync(sessDir(uuid))
    notes.startEventSessionId = eventsOf(uuid).find((e) => e.type === 'session.start')?.data?.sessionId
    wr('screen-idle.txt', screen(T))
    const aic = (n) => { const m = screen(T).match(/Session: ([\d.]+) AIC used/); notes['aic_' + n] = m ? Number(m[1]) : null }
    aic('before')
    // prompt 1: a shell command that needs approval, hook ALLOWS after 2 s (inside timeoutSec 5) -> dialog must be skipped
    fs.writeFileSync(path.join(PLUGIN, 'hold-secs'), '2')
    fs.writeFileSync(path.join(PLUGIN, 'hold-mode'), 'allow')
    await prompt(T, 'Use the bash tool to run exactly: touch c0.txt && echo done')
    notes.p1Done = !!(await waitFor('agentStop1', () => hookCount('agentStop') >= 1, 90000))
    await sleep(2500)
    notes.agentStopAfterP1 = hookCount('agentStop')
    notes.c0Created = fs.existsSync(path.join(REPO, 'c0.txt'))
    wr('screen-after-p1.txt', screen(T))
    aic('afterP1')
    // context anywhere besides /context? sidebar, ?-help, footer
    keys(T, 'Left'); await sleep(1500); wr('screen-sidebar.txt', screen(T)); keys(T, 'Escape'); await sleep(500)
    await sendLine(T, '/context'); await sleep(3000); wr('screen-context.txt', screen(T))
    await sendLine(T, '/usage'); await sleep(3000); wr('screen-usage.txt', screen(T))

    // ---- 2. permission dialog, hook held 20 s with timeoutSec 5
    fs.writeFileSync(path.join(PLUGIN, 'hold-secs'), '20')
    const before = hooks().length
    await prompt(T, 'Use the bash tool to run exactly: touch c1.txt && echo done')
    const t0 = Date.now()
    const timeline = []
    let pressed = null
    while (Date.now() - t0 < 60000) {
      const s = screen(T)
      const dlg = /Do you want to run this command/.test(s)
      const pr = hooks().slice(before).filter((h) => h.ev === 'permissionRequest')
      timeline.push({ dt: Date.now() - t0, dialog: dlg, permHookStarts: pr.filter((h) => h.phase === 'start').length, permHookEnds: pr.filter((h) => h.phase === 'end').length, permHookKilled: pr.filter((h) => h.phase === 'killed').length })
      if (dlg && !pressed) { wr('screen-perm-dialog.txt', s); pressed = Date.now() - t0; await sleep(3000); keys(T, '1'); break } // digit, NO Return
      await sleep(1000)
    }
    notes.permDialogAtMs = pressed
    notes.permTimeline = timeline
    await waitFor('p2 agentStop', () => hookCount('agentStop') >= 2, 60000)
    await sleep(2500)
    notes.agentStopAfterP2 = hookCount('agentStop')
    aic('afterP2')
    notes.c1Created = fs.existsSync(path.join(REPO, 'c1.txt'))
    wr('screen-after-p2.txt', screen(T))
    fs.writeFileSync(path.join(PLUGIN, 'hold-secs'), '0')

    // ---- 3. exit, check shutdown + lock
    await sendLine(T, '/exit')
    await waitFor('exit', () => !alive(T), 20000)
    await waitFor('shutdown', () => eventsOf(uuid).some((e) => e.type === 'session.shutdown'), 30000)
    await sleep(6000) // OTel metrics flush
    notes.lockGone = !fs.readdirSync(sessDir(uuid)).some((f) => f.startsWith('inuse.'))
    notes.eventsLinesAfterFirstRun = eventsOf(uuid).length

    // ---- 4. --session-id=<existing> resumes? (no prompt)
    start(T, [`--session-id=${uuid}`, ...base], { COPILOT_OTEL_FILE_EXPORTER_PATH: otel('b') })
    await boot(T)
    await sleep(2500)
    const sb = screen(T)
    wr('screen-sessionid-resume.txt', sb)
    notes.sessionIdResumeShowsHistory = /touch c0\.txt/.test(sb) && /touch c1\.txt/.test(sb)
    await sendLine(T, '/exit')
    await waitFor('exit2', () => !alive(T), 20000)
    await sleep(2000)

    // ---- 5. --resume=<id>, prompt 3
    start(T, [`--resume=${uuid}`, ...base], { COPILOT_OTEL_FILE_EXPORTER_PATH: otel('c') })
    await boot(T)
    await sleep(2500)
    const sc = screen(T)
    wr('screen-resume.txt', sc)
    notes.resumeShowsHistory = /touch c0\.txt/.test(sc)
    await prompt(T, 'Reply with exactly the single word: again. Do not use any tools.')
    await waitFor('agentStop3', () => hookCount('agentStop') >= 3, 90000)
    await sleep(2500)
    aic('afterP3')
    notes.agentStopAfterP3 = hookCount('agentStop')
    await sendLine(T, '/exit')
    await waitFor('exit3', () => !alive(T), 20000)
    await sleep(6000)
  } finally {
    if (alive(T)) { try { tm('kill-session', '-t', T) } catch {} }
  }
  notes.promptsSent = promptsSent
  notes.sessionIdOfEvents = [...new Set(eventsOf(uuid).filter((e) => e.type === 'session.start').map((e) => e.data?.sessionId))]
  notes.sessionStartCount = eventsOf(uuid).filter((e) => e.type === 'session.start').length
  wr('notes.json', notes)
  harvest(uuid)
  log('run done', JSON.stringify({ ...notes, permTimeline: undefined }))
}

// ---------------------------------------------------------------- fixtures / samples
function trim(v) {
  if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + `…[${v.length}]` : v
  if (Array.isArray(v)) return v.slice(0, 12).map(trim)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)]))
  return v
}
function harvest(uuid) {
  const ev = eventsOf(uuid)
  fs.writeFileSync(path.join(OUT, 'events-1091.jsonl'), ev.map((e) => JSON.stringify(trim(e))).join('\n') + '\n')
  const dir = path.join(OUT, 'hook-samples')
  fs.mkdirSync(dir, { recursive: true })
  const seen = new Set()
  for (const h of hooks()) {
    if (h.phase !== 'start' || seen.has(h.ev)) continue
    seen.add(h.ev)
    fs.writeFileSync(path.join(dir, `${h.ev}.json`), JSON.stringify(trim(h.payload), null, 1))
  }
  // OTel: one trimmed line per distinct span name + attribute key inventory
  const inv = {}
  for (const f of fs.readdirSync(OUT).filter((f) => /^otel-[abc]\.jsonl$/.test(f))) {
    for (const r of readJsonl(path.join(OUT, f))) {
      const nm = r.name ?? r.type ?? '?'
      const at = r.attributes ?? r.attrs ?? {}
      inv[nm] ??= { n: 0, keys: new Set(), sample: null }
      inv[nm].n++
      Object.keys(at).forEach((k) => inv[nm].keys.add(k))
      inv[nm].sample ??= trim(r)
    }
  }
  wr('otel-inventory.json', Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, { n: v.n, keys: [...v.keys].sort(), sample: v.sample }])))
  const types = {}
  ev.forEach((e) => { types[e.type] = (types[e.type] ?? 0) + 1 })
  wr('event-type-counts.json', types)
}

// ---------------------------------------------------------------- main
setup()
if (want('schema')) schemaDiff()
let models = null
if (want('models') || want('run')) {
  models = await acpModels()
  log('acp models:', JSON.stringify(models.sn?.result?.models ?? models.sn?.error).slice(0, 600))
}
if (want('run')) await run(models)
const left = (() => { try { return tm('list-sessions', '-F', '#{session_name}').split('\n').filter((n) => n.startsWith(PREFIX)) } catch { return [] } })()
log('probe tmux sessions left:', left.length)
