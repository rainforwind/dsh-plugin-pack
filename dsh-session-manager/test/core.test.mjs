// Offline verification of dsh-session-manager's shared deletion core.
// Mocks the host seams the core touches; no live Harness needed.
import { mkdtemp, mkdir, writeFile, access, rm as rmfs } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { deleteArchivedSession, describeSession, sessionDir } from '../lib/index.js'

let failures = 0
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!cond) failures++
}
const exists = async (p) => { try { await access(p); return true } catch { return false } }

const root = await mkdtemp(join(tmpdir(), 'sm-core-'))
const cwd = join(root, 'proj')
const sid = 'session-deadbeef-0000-0000-0000-000000000000'
const ghostCwd = join(root, 'vanished-project')
let dir = sessionDir(root, cwd, sid)

function makeCtx({ archived = true, resident = false, activitySeq = [], cwdOverride, onDisk = true } = {}) {
  const trace = []
  const archivedIds = archived ? [sid] : []
  const workspace = { detachSession: async (id) => trace.push(['detach', id, { dirExists: await exists(dir) }]) }
  const state = { activitySeq: [...activitySeq] }
  const effectiveCwd = cwdOverride === undefined ? cwd : cwdOverride
  const ctx = {
    trace, state, archivedIds,
    get(name) {
      if (name === 'sessionPersistence') return {
        root,
        stat: async (id) => (onDisk && id === sid ? { header: { cwd: effectiveCwd } } : undefined),
      }
      if (name === 'workspaceRegistry') return {
        get archivedSessionIds() { return archivedIds },
        unarchiveSession: async (id) => {
          const index = archivedIds.indexOf(id)
          if (index >= 0) archivedIds.splice(index, 1)
          trace.push(['unarchive', id])
        },
        resolveByPath: async (p) => {
          trace.push(['resolveByPath', p])
          return /\/proj$/.test(String(p)) ? workspace : undefined
        },
        entities: new Map([['ws-1', workspace]]),
      }
      if (name === 'sessions') return { get: (id) => (resident && id === sid ? {} : undefined) }
      if (name === 'agents') return undefined
      return undefined
    },
    waterfall(name, payload, next) {
      trace.push(['waterfall', name])
      return Promise.resolve(state.activitySeq.length > 0 ? state.activitySeq.shift() : next())
    },
    parallel(name, payload) { trace.push(['stop', name]); return Promise.resolve() },
    emit(name, id) { trace.push(['emit', name, id]) },
    logger: { info() {}, warn(...a) { console.error('WARN', ...a) } },
  }
  return ctx
}

const freshFiles = async (targetDir) => {
  await rmfs(root, { recursive: true, force: true })
  await mkdir(cwd, { recursive: true })
  if (targetDir) {
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'session.v4.jsonl'), '{"type":"header"}\n')
  }
}

// 1. happy path: archived + cold → deletes, order waterfall→unarchive→resolve→detach→emit
dir = sessionDir(root, cwd, sid)
await freshFiles(dir)
{
  const ctx = makeCtx()
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 100 })
  check('happy: ok', r.ok === true && r.ghost === false, JSON.stringify(r))
  check('happy: files removed', !(await exists(dir)))
  const kinds = ctx.trace.map((t) => t[0])
  check('happy: order waterfall→unarchive→resolve→detach→emit',
    kinds.join(',') === 'waterfall,unarchive,resolveByPath,detach,emit', kinds.join(','))
  check('happy: exactly one unarchive (no self-heal loop)',
    ctx.trace.filter((t) => t[0] === 'unarchive').length === 1)
  const detachRow = ctx.trace.find((t) => t[0] === 'detach')
  check('happy: detach AFTER rm (dir already gone)', detachRow && detachRow[2].dirExists === false)
  check('happy: archived set empty after', ctx.archivedIds.length === 0)
}

// 2. not archived → refusal, NOTHING touched
await freshFiles(dir)
{
  const ctx = makeCtx({ archived: false })
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 100 })
  check('not-archived refusal', r.ok === false && r.code === 'not-archived', JSON.stringify(r))
  check('not-archived: files intact', await exists(dir))
  check('not-archived: no side effects', ctx.trace.length === 0, ctx.trace.map(t => t[0]).join(','))
}

// 3. resident → stop attempted, then refusal 'resident'; nothing deleted
await freshFiles(dir)
{
  const ctx = makeCtx({ resident: true })
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 300 })
  check('resident refusal', r.ok === false && r.code === 'resident', JSON.stringify(r))
  check('resident: stop issued', ctx.trace.some((t) => t[0] === 'stop'))
  check('resident: files intact', await exists(dir))
  check('resident: still archived (no unarchive)', !ctx.trace.some((t) => t[0] === 'unarchive'))
}

// 4. active turn that settles after stop → poll succeeds → deletion proceeds
await freshFiles(dir)
{
  const ctx = makeCtx({ activitySeq: [[{ kind: 'turn' }], []] })
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 2000 })
  check('activity settles → ok', r.ok === true, JSON.stringify(r))
  check('activity: files removed', !(await exists(dir)))
}

// 5. active turn that never settles → refusal 'live'
await freshFiles(dir)
{
  const ctx = makeCtx()
  ctx.waterfall = function (name, payload, next) {
    this.trace.push(['waterfall', name])
    return Promise.resolve([{ kind: 'turn' }])
  }
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 300 })
  check('activity persists → live refusal', r.ok === false && r.code === 'live', JSON.stringify(r))
  check('live: files intact', await exists(dir))
}

// 6. unknown id + not archived → not-archived (the archived guard runs first)
{
  const ctx = makeCtx()
  const r = await deleteArchivedSession(ctx, 'session-nope', { graceMs: 100 })
  check('unknown → not-archived', r.ok === false && r.code === 'not-archived', JSON.stringify(r))
}

// 7. vanished cwd + on disk → delete ok, membership detached via entity scan
{
  dir = sessionDir(root, ghostCwd, sid)
  await freshFiles(dir)
  const ctx = makeCtx({ cwdOverride: ghostCwd })
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 100 })
  check('vanished cwd: delete ok', r.ok === true, JSON.stringify(r))
  check('vanished cwd: files removed', !(await exists(dir)))
  check('vanished cwd: detach via scan', ctx.trace.some((t) => t[0] === 'detach'),
    ctx.trace.map(t => t[0]).join(','))
}

// 8. GHOST: archived entry, stat says gone → headerless sweep still clears residue + archive entry
{
  dir = sessionDir(root, ghostCwd, sid)   // residue under a project dir, no header
  await freshFiles(dir)
  const ctx = makeCtx({ onDisk: false })
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 100 })
  check('ghost: ok + flagged', r.ok === true && r.ghost === true, JSON.stringify(r))
  check('ghost: residue swept', !(await exists(dir)))
  check('ghost: archive entry cleared', ctx.archivedIds.length === 0)
  check('ghost: membership detached', ctx.trace.some((t) => t[0] === 'detach'),
    ctx.trace.map(t => t[0]).join(','))
  check('ghost: emit sent', ctx.trace.some((t) => t[0] === 'emit' && t[1] === 'api-session/removed'))
  check('ghost: no resolveByPath (no header)', !ctx.trace.some((t) => t[0] === 'resolveByPath'),
    ctx.trace.map(t => t[0]).join(','))
}

// 9. GHOST variant: residue at root level / _no-cwd layout
{
  await freshFiles(null)
  const rawDir = join(root, '_no-cwd', sid)
  await mkdir(rawDir, { recursive: true })
  await writeFile(join(rawDir, 'session.v4.jsonl'), '{}\n')
  const ctx = makeCtx({ onDisk: false })
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 100 })
  check('_no-cwd ghost: ok', r.ok === true && r.ghost === true, JSON.stringify(r))
  check('_no-cwd ghost: residue swept', !(await exists(rawDir)))
}

// 10. describeSession: resident counts as live; cold archived is not live; split exposed
{
  await freshFiles(null)
  const ctx = makeCtx({ resident: true })
  const s = await describeSession(ctx, sid)
  check('describe: resident → live', s.live === true && s.archived === true, JSON.stringify(s))
  check('describe: resident split names sessions map', s.resident && s.resident.sessions === true)
  const ctx2 = makeCtx()
  const s2 = await describeSession(ctx2, sid)
  check('describe: cold → not live', s2.live === false, JSON.stringify(s2))
  check('describe: cold split + activity', s2.resident.sessions === false && s2.activity === 0)
}

// 11. core refusal message names the parent for a delegated child
{
  await freshFiles(dir)
  const ctx = makeCtx({ resident: true })
  const realGet = ctx.get.bind(ctx)
  const stat = async (id) => (id === sid ? { header: { cwd, parentSession: 'session-parent-1111' } } : undefined)
  ctx.get = (name) => (name === 'sessionPersistence' ? { root, stat } : realGet(name))
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 200 })
  check('resident delegation: refusal names parent',
    r.ok === false && r.code === 'resident' && /session-parent-1111/.test(r.message), r.message)
}

// 12. force bypasses residency (idle held instance) — full deletion proceeds
{
  dir = sessionDir(root, cwd, sid)
  await freshFiles(dir)
  const ctx = makeCtx({ resident: true })
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 200, force: true })
  check('force+idle: ok + forced', r.ok === true && r.forced === true, JSON.stringify(r))
  check('force+idle: files removed', !(await exists(dir)))
  check('force+idle: archive entry cleared', ctx.archivedIds.length === 0)
  check('force+idle: membership detached', ctx.trace.some((t) => t[0] === 'detach'))
  // The Client picks its result notice from this flag, so the plain-delete
  // result must say forced:false rather than omitting it.
  check('force+idle: forced is a boolean', typeof r.forced === 'boolean')
}

// 12b. unforced delete reports forced:false (the dialog then shows the plain copy)
{
  dir = sessionDir(root, cwd, sid)
  await freshFiles(dir)
  const ctx = makeCtx()
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 100 })
  check('plain delete: ok + forced:false', r.ok === true && r.forced === false, JSON.stringify(r))
}

// 13. force never bypasses running work — 'live' even with force
{
  dir = sessionDir(root, cwd, sid)
  await freshFiles(dir)
  const ctx = makeCtx({ resident: true })
  ctx.waterfall = function (name, payload) {
    this.trace.push(['waterfall', name])
    return Promise.resolve([{ kind: 'turn' }])
  }
  const r = await deleteArchivedSession(ctx, sid, { graceMs: 300, force: true })
  check('force+running → live refusal', r.ok === false && r.code === 'live', JSON.stringify(r))
  check('force+running: files intact', await exists(dir))
  check('force+running: still archived', ctx.archivedIds.includes(sid))
}

await rmfs(root, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
