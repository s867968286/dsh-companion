/**
 * 「会话 → 伙伴」恢复判据的回归测试。
 *
 * 用户确认的四层优先级（见 project 记忆「伙伴恢复判据：binding 优先」）：
 *   ① 是不是伙伴模式 —— 读事件流的 `agentPreset`，**只做提示**，用来拦截
 *      「标准会话被注入伙伴人设」；
 *   ② 是哪个伙伴 —— 查 `bindings.json`（唯一正式来源）；
 *   ③ binding 没有 —— 兼容历史上的 `companion/selected` 事件（实测有会话只靠这条）；
 *   ④ 全都拿不到 —— 判为无效会话，**不注入**。
 *
 * 另一半：`agent/disposed` **不再删 binding**，否则重开会话时 binding 已不在，
 * 兜底形同虚设。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { archiveAgent, registerRoutes } from '../src/index.js'
import { resolvePaths, writeBinding, readBindings } from '../src/settings.mjs'
import { COMPANION_PRESET_ID } from '../src/companion-preset.mjs'
import { COMPANION_EVENT } from '../src/companion.mjs'

/** 假 ctx：只需要 registerRoutes 用到的 on/emit/webServer/logger。 */
function makeCtx() {
  const listeners = new Map()
  const warns = []
  return {
    warns,
    logger: { warn: (m) => warns.push(String(m)), info: () => {} },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    webServer: { register: () => () => {} },
  }
}

/**
 * 造一个 agent：`agent.ctx` 必须存在（注入注册要用），
 * 并记录 systemPrompt.section/variable 的注册——以此判断「有没有装注入」。
 */
function makeAgent(sessionId, { preset, events = [] } = {}) {
  const sections = []
  const vars = new Map()
  const session = {
    id: sessionId,
    header: preset === undefined ? {} : { agentPreset: preset },
    snapshotEvents: () => events,
    ownEvents: () => events,
  }
  return {
    sections,
    vars,
    agent: {
      id: sessionId,
      session,
      ctx: {
        systemPrompt: {
          section(section) {
            sections.push(section)
            return () => {
              const i = sections.indexOf(section)
              if (i >= 0) sections.splice(i, 1)
            }
          },
          variable(name, provider) {
            vars.set(name, provider)
            return () => {}
          },
        },
      },
    },
  }
}

/** 建一个装了伙伴目录的 home，返回 paths。 */
function makeHome(companionIds = ['lily']) {
  const home = mkdtempSync(join(tmpdir(), 'companion-recover-'))
  const paths = resolvePaths(home)
  for (const id of companionIds) mkdirSync(join(paths.companionsRoot, id), { recursive: true })
  return { home, paths }
}

/** 等异步绑定写入的队列跑完（监听器里是 fire-and-forget）。 */
const settle = () => new Promise((r) => setTimeout(r, 0))

const presetEvent = (preset) => ({ type: 'agent-preset/selected', data: { agentPreset: preset } })
const legacyBindEvent = (id) => ({ type: COMPANION_EVENT, data: { companion: id } })

test('恢复①：binding 有 + 预设是伙伴模式 → 装上注入', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 's1', 'lily')
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  const { agent, sections } = makeAgent('s1', { preset: COMPANION_PRESET_ID, events: [presetEvent(COMPANION_PRESET_ID)] })
  ctx.emit('agent/created', { agent })
  assert.equal(sections.length, 1, '伙伴模式会话应装上 complete section')
  rmSync(home, { recursive: true, force: true })
})

test('恢复②：binding 有，但会话已切到别的预设 → 不注入，并清掉残留绑定', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 's1', 'lily')
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  const { agent, sections } = makeAgent('s1', { preset: 'standard-gitbash', events: [presetEvent('standard-gitbash')] })
  ctx.emit('agent/created', { agent })
  assert.equal(sections.length, 0, '标准会话绝不能被注入伙伴人设')
  // 写绑定是异步的，且监听器里是 fire-and-forget（同步监听器不能 await）：
  // 等队列跑完再断言盘上状态。
  await settle()
  assert.equal(readBindings(paths).s1, undefined, '残留绑定应被清掉')
  rmSync(home, { recursive: true, force: true })
})

test('恢复③：识别不出预设（事件流无预设记录）→ 不注入（宁可少注入不可错注入）', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 's1', 'lily')
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  // header 无 agentPreset，事件流里也没有 agent-preset/selected
  const { agent, sections } = makeAgent('s1', {})
  ctx.emit('agent/created', { agent })
  assert.equal(sections.length, 0, '识别不出伙伴模式时不得注入')
  rmSync(home, { recursive: true, force: true })
})

test('恢复④：binding 没有但事件流有历史绑定 → 兼容兜底，装上注入', async () => {
  const { home, paths } = makeHome()
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  const { agent, sections } = makeAgent('s1', {
    preset: COMPANION_PRESET_ID,
    events: [presetEvent(COMPANION_PRESET_ID), legacyBindEvent('lily')],
  })
  ctx.emit('agent/created', { agent })
  assert.equal(sections.length, 1, '历史遗留会话应靠事件流兜底恢复')
  rmSync(home, { recursive: true, force: true })
})

test('恢复⑤：binding 与事件流都没有 → 不注入', async () => {
  const { home } = makeHome()
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  const { agent, sections } = makeAgent('s1', { preset: COMPANION_PRESET_ID, events: [presetEvent(COMPANION_PRESET_ID)] })
  ctx.emit('agent/created', { agent })
  assert.equal(sections.length, 0, '两级都没有时判为无效会话')
  rmSync(home, { recursive: true, force: true })
})

test('恢复⑥：binding 指向的伙伴目录已不存在 → 不注入', async () => {
  const { home, paths } = makeHome(['lily'])
  await writeBinding(paths, 's1', 'ghost')
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  const { agent, sections } = makeAgent('s1', { preset: COMPANION_PRESET_ID, events: [presetEvent(COMPANION_PRESET_ID)] })
  ctx.emit('agent/created', { agent })
  assert.equal(sections.length, 0, '伙伴目录不存在时不注入')
  rmSync(home, { recursive: true, force: true })
})

test('恢复⑦：agent/disposed 不再清 binding（重开会话才能靠它恢复）', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 's1', 'lily')
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  const { agent } = makeAgent('s1', { preset: COMPANION_PRESET_ID, events: [presetEvent(COMPANION_PRESET_ID)] })
  ctx.emit('agent/created', { agent })
  ctx.emit('agent/disposed', { agent })
  assert.equal(readBindings(paths).s1, 'lily', 'disposed 后 binding 必须还在，否则重开会话恢复不了')
  rmSync(home, { recursive: true, force: true })
})

test('恢复⑧：disposed 后重开同一会话，仍能按 binding 装回注入', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 's1', 'lily')
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  const first = makeAgent('s1', { preset: COMPANION_PRESET_ID, events: [presetEvent(COMPANION_PRESET_ID)] })
  ctx.emit('agent/created', { agent: first.agent })
  assert.equal(first.sections.length, 1)
  ctx.emit('agent/disposed', { agent: first.agent })
  // 重开：官方会新建一个 agent 对象
  const second = makeAgent('s1', { preset: COMPANION_PRESET_ID, events: [presetEvent(COMPANION_PRESET_ID)] })
  ctx.emit('agent/created', { agent: second.agent })
  assert.equal(second.sections.length, 1, '重开会话必须靠 binding 装回伙伴人设（W3）')
  rmSync(home, { recursive: true, force: true })
})

test('恢复⑨：显式「无伙伴」（binding 为 null）→ 不注入', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 's1', null)
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  const { agent, sections } = makeAgent('s1', { preset: COMPANION_PRESET_ID, events: [presetEvent(COMPANION_PRESET_ID)] })
  ctx.emit('agent/created', { agent })
  assert.equal(sections.length, 0, '用户显式选「无伙伴」时不得注入')
  rmSync(home, { recursive: true, force: true })
})

test('恢复⑩：删除伙伴会清掉所有指向它的绑定（并把数量报出来）', async () => {
  const { home, paths } = makeHome(['lily', 'alice'])
  await writeBinding(paths, 's1', 'lily')
  await writeBinding(paths, 's2', 'lily')
  await writeBinding(paths, 's3', 'alice')
  const result = await archiveAgent(paths, 'lily')
  assert.equal(result.bindingsRemoved, 2, '应报告清掉了 2 条')
  const left = readBindings(paths)
  assert.equal(left.s1, undefined)
  assert.equal(left.s2, undefined)
  assert.equal(left.s3, 'alice', '别的伙伴的绑定不受影响')
  rmSync(home, { recursive: true, force: true })
})

test('恢复⑪：删除伙伴后重开该会话 → 目录已不在，不注入（不静默挂着坏绑定）', async () => {
  const { home, paths } = makeHome(['lily'])
  await writeBinding(paths, 's1', 'lily')
  await archiveAgent(paths, 'lily')
  const ctx = makeCtx()
  registerRoutes(ctx, home)
  const { agent, sections } = makeAgent('s1', { preset: COMPANION_PRESET_ID, events: [presetEvent(COMPANION_PRESET_ID)] })
  ctx.emit('agent/created', { agent })
  assert.equal(sections.length, 0, '伙伴已删，不得再按残留绑定注入')
  rmSync(home, { recursive: true, force: true })
})
