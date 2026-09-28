/**
 * host 半注入（injectCompanionPrompt）的回归测试。
 *
 * 锁两个评审发现：
 * - E1：provider 必须按会话冻结——同一会话反复调用返回**逐字节同一份文本**，
 *   且改盘上的 MD 后 provider 仍返回旧文本（改文件要新开对话才生效）；
 * - W1：占位符在 host 半注入路径同样生效（{{cwd}} / {{presetDir}} / {{session}}）。
 *
 * provider 收到的 context 形状对齐官方 `assembleContextFor`
 * （dsh-agent/lib/index.js:291-295）：`{ agent, scope }`，session 经 agent 可达。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { injectCompanionPrompt } from '../src/companion.mjs'

/** 建一个伙伴目录：SOUL.md 正文可带占位符。 */
function makeCompanionDir(body) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-inject-'))
  writeFileSync(join(dir, 'SOUL.md'), body, 'utf8')
  return dir
}

/** 假 ctx：记录 section / variable 注册。 */
function makeCtx() {
  const sections = []
  const variables = new Map()
  return {
    sections,
    variables,
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const index = sections.indexOf(section)
          if (index >= 0) sections.splice(index, 1)
        }
      },
      variable(name, provider) {
        variables.set(name, provider)
        return () => {}
      },
    },
  }
}

/** 官方形态的 assemble context（assembleContextFor 的输出）。 */
const asContext = (sessionId) => ({
  agent: { id: sessionId, session: { id: sessionId, header: { cwd: 'D:/ws/demo', agentPreset: 'companion-mode' } } },
})

test('E1 冻结：同一会话多次调用返回同一文本', () => {
  const dir = makeCompanionDir('# 灵魂\n\n稳定文本')
  const ctx = makeCtx()
  injectCompanionPrompt(ctx, dir, () => ({ budgetNotice: false }))
  const provider = ctx.variables.get('companion_persona')
  assert.ok(provider, '变量 provider 应已注册')
  const context = asContext('session-A')
  assert.equal(provider(context), provider(context), '同一会话两次求值必须逐字节相同')
  rmSync(dir, { recursive: true, force: true })
})

test('E1 冻结：改盘上 MD 后同一会话仍拿旧文本，新会话拿到新文本', () => {
  const dir = makeCompanionDir('# 灵魂\n\n版本一')
  const ctx = makeCtx()
  injectCompanionPrompt(ctx, dir, () => ({ budgetNotice: false }))
  const provider = ctx.variables.get('companion_persona')
  const contextA = asContext('session-A')
  assert.equal(provider(contextA), '# 灵魂\n\n版本一')
  // 盘上改内容：会话 A 必须仍然冻结在旧文本
  writeFileSync(join(dir, 'SOUL.md'), '# 灵魂\n\n版本二', 'utf8')
  assert.equal(provider(contextA), '# 灵魂\n\n版本一', '会话内必须冻结')
  // 新会话 B：应读到新文本
  assert.equal(provider(asContext('session-B')), '# 灵魂\n\n版本二', '新会话读新文本')
  rmSync(dir, { recursive: true, force: true })
})

test('E1 冻结：refresh 换目录后旧缓存失效，按新目录重读', () => {
  const dirA = makeCompanionDir('# 灵魂\n\n甲')
  const dirB = makeCompanionDir('# 灵魂\n\n乙')
  const ctx = makeCtx()
  const handle = injectCompanionPrompt(ctx, dirA, () => ({ budgetNotice: false }))
  const context = asContext('session-A')
  assert.equal(ctx.variables.get('companion_persona')(context), '# 灵魂\n\n甲')
  handle.refresh(dirB)
  // refresh 会 dispose 旧 provider、注册新 provider：真实路径只走新的，取当前注册的这份。
  const providerB = ctx.variables.get('companion_persona')
  assert.equal(providerB(context), '# 灵魂\n\n乙', '换目录后按新目录重新渲染')
  // 再 refresh 回旧目录：旧缓存已在 clear 时清空，重装后重读盘。
  handle.refresh(dirA)
  assert.equal(ctx.variables.get('companion_persona')(context), '# 灵魂\n\n甲')
  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
})

test('E1 冻结：dispose 后再 install 不复用旧缓存', () => {
  const dir = makeCompanionDir('# 灵魂\n\n版本一')
  const ctx = makeCtx()
  const handle = injectCompanionPrompt(ctx, dir, () => ({ budgetNotice: false }))
  const context = asContext('session-A')
  assert.equal(ctx.variables.get('companion_persona')(context), '# 灵魂\n\n版本一')
  writeFileSync(join(dir, 'SOUL.md'), '# 灵魂\n\n版本二', 'utf8')
  handle.dispose()
  handle.refresh(dir) // 重新安装同目录（refresh 内部先 clear 再 install）
  assert.equal(ctx.variables.get('companion_persona')(context), '# 灵魂\n\n版本二', 'dispose 后重装应重读盘')
  rmSync(dir, { recursive: true, force: true })
})

test('W1 占位符：host 半注入路径 cwd/presetDir/session 均被替换', () => {
  const dir = makeCompanionDir('工作目录={{cwd}}\n预设目录={{presetDir}}\n会话={{session}}')
  const ctx = makeCtx()
  injectCompanionPrompt(ctx, dir, () => ({ budgetNotice: false }))
  const provider = ctx.variables.get('companion_persona')
  const rendered = provider(asContext('session-A'))
  assert.ok(rendered.includes('工作目录=D:/ws/demo'), `cwd 应替换：${rendered}`)
  assert.ok(rendered.includes(`预设目录=${dir}`), `presetDir 应替换：${rendered}`)
  assert.ok(rendered.includes('会话=session-A'), `session 应替换：${rendered}`)
  rmSync(dir, { recursive: true, force: true })
})

test('E1 冻结：上下文取不到会话时按 cwd+presetDir 兜底键，不串味', () => {
  const dirA = makeCompanionDir('工作目录={{cwd}}')
  const ctx = makeCtx()
  injectCompanionPrompt(ctx, dirA, () => ({ budgetNotice: false }))
  const provider = ctx.variables.get('companion_persona')
  const noSession = { agent: { id: 'x', session: { header: { cwd: 'D:/ws/one' } } } }
  const first = provider(noSession)
  assert.equal(provider(noSession), first, '同 cwd 多次求值恒定')
  assert.ok(first.includes('工作目录=D:/ws/one'))
  rmSync(dirA, { recursive: true, force: true })
})
