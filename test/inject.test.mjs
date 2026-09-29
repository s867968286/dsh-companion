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
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

import { injectCompanionPrompt, restrictCompanionTools } from '../src/companion.mjs'

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
  /*
   * runtime-context 屏蔽的记账：suppressors 是"当前活跃的屏蔽数"，
   * 每次 suppressRuntimeContext() 返回一个把它减一的 disposer ——
   * 完全对齐官方语义（dsh-system-prompt/lib/index.js:276 返回 effect disposer）。
   */
  const suppressors = { count: 0 }
  return {
    sections,
    variables,
    suppressors,
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
      suppressRuntimeContext() {
        suppressors.count += 1
        let lifted = false
        return () => {
          if (lifted) return
          lifted = true
          suppressors.count -= 1
        }
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

/* ------------------------------------------------------------------ *
 * 按伙伴收窄工具（restrictCompanionTools）
 *
 * 这段逻辑 2026-09-28 从 preset 行插件搬到 agent scope，因为它必须按**伙伴**
 * 而不是按预设生效 —— 官方 `tools.restrict()` 要求 agent.ctx
 * （dsh-tools/lib/index.js:2897）。锁四件事：
 * ① 伙伴配了 allow/deny → 展开通配后下发；
 * ② 没配 → 一条都不下发（否则会把全部工具挡掉）；
 * ③ 通配展开为空 → 不下发（避免"空 allow 屏蔽全部"）；
 * ④ 名字写错 → 只警告，不抛（收窄是优化，不该让会话起不来）。
 * ------------------------------------------------------------------ */

/** 假 ctx：记录 restrict 调用，可注入已知工具名单与抛错行为。 */
function makeToolsCtx({ known = ['mnemon_recall', 'mnemon_store', 'read'], throwOnRestrict = null } = {}) {
  const restricted = []
  const logs = { info: [], warn: [] }
  return {
    restricted,
    logs,
    tools: {
      view: () => ({ restrictableNames: new Set(known) }),
      schemas: () => known.map((name) => ({ name })),
      restrict(filter) {
        if (throwOnRestrict) throw new Error(throwOnRestrict)
        restricted.push(filter)
      },
    },
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
    },
  }
}

test('按伙伴收窄：deny 前缀通配展开成实际工具名后下发', () => {
  const ctx = makeToolsCtx()
  const result = restrictCompanionTools(ctx, { deny: ['mnemon*'] }, ctx.logger)

  assert.equal(result.applied, true)
  assert.deepEqual(
    ctx.restricted,
    [{ deny: ['mnemon_recall', 'mnemon_store'] }],
    '前缀通配应展开成实际存在的两个工具，而不是把 "mnemon*" 原样下发',
  )
  assert.ok(ctx.logs.info.join('\n').includes('工具收窄已生效'))
})

test('按伙伴收窄：allow 白名单（纯聊天伙伴的主要用法）', () => {
  const ctx = makeToolsCtx({ known: ['read', 'write', 'web_search', 'ask_user_question'] })
  const result = restrictCompanionTools(ctx, { allow: ['read', 'web_search', 'ask_user_question'] }, ctx.logger)

  assert.equal(result.applied, true)
  assert.deepEqual(ctx.restricted, [{ allow: ['ask_user_question', 'read', 'web_search'] }], '名单应排序后下发')
})

test('按伙伴收窄：没配 tools 时一条都不下发', () => {
  /*
   * 这是最要紧的一条安全性质：**下发空 allow 会屏蔽全部全局工具**
   * （applyToolRestriction 的注释专门讲过）。没配 = 不限制 = 不下发。
   */
  for (const tools of [undefined, null, {}, { allow: [] }, { deny: [] }]) {
    const ctx = makeToolsCtx()
    const result = restrictCompanionTools(ctx, tools, ctx.logger)
    assert.equal(result.applied, false, `${JSON.stringify(tools)} 不该下发收窄`)
    assert.deepEqual(ctx.restricted, [], `${JSON.stringify(tools)} 不该碰 restrict`)
  }
})

test('按伙伴收窄：通配展开为空时不下发，只警告 unmatched', () => {
  /*
   * 典型场景：伙伴写了 deny: ['mnemon*'] 但机器上没装 mnemon。
   * 展开成空集后若照常下发 `{deny: []}`，语义上无害；但 `{allow: []}`
   * 会屏蔽全部工具，所以统一"空就不下发"，避免哪天语义变化踩雷。
   */
  const ctx = makeToolsCtx({ known: ['read', 'write'] })
  const result = restrictCompanionTools(ctx, { deny: ['mnemon*'] }, ctx.logger)

  assert.equal(result.applied, false)
  assert.deepEqual(ctx.restricted, [], '展开为空不该下发')
  assert.deepEqual(result.unmatched, ['mnemon*'], '应报告未匹配的模式')
  assert.ok(ctx.logs.warn.join('\n').includes('mnemon*'), '未匹配的模式必须有 warn')
})

test('按伙伴收窄：restrict 抛错时只警告，不向上抛', () => {
  /*
   * 收窄失败必须降级为"工具全可见"，而不是让整个会话起不来。
   * 名字写错（未知名）正是官方会抛的那类错误。
   */
  const ctx = makeToolsCtx({ throwOnRestrict: 'tools.restrict() names unknown global tool "x"' })
  let threw = false
  let result
  try {
    result = restrictCompanionTools(ctx, { deny: ['read'] }, ctx.logger)
  } catch {
    threw = true
  }
  assert.equal(threw, false, '不该向上抛')
  assert.equal(result.applied, false)
  assert.ok(ctx.logs.warn.join('\n').includes('工具收窄未生效'), '失败要有 warn 可查')
})

test('按伙伴收窄：精确名原样下发，不存在的名字交由官方校验（我们只降级为 warn）', () => {
  /*
   * ⚠️ 语义在 2026-09-28 变了。
   *
   * 早先 expand() 拿**全局名单**过滤精确名，看似稳妥，实则致命：
   * `view()` 只给全局层工具，而 agent 可见的还有一大块来自**预设层**
   * （tool-fs/tool-web 注册的 read/write/web_search…）。于是合法的预设层工具
   * 被当成"未匹配"丢掉 —— 实测事故：伙伴配 10 项 allow，会话只剩 2 个工具
   * （恰好是全局层的 read_page / x_search）。
   *
   * 现在：精确名**原样**交给 restrict，由它用 `view(agentScope)` 这份
   * **正确的** scoped 名单校验。不存在的名字会抛错 → 我们降级成 warn。
   */
  const ctx = makeToolsCtx({ known: ['read', 'write'] })
  const result = restrictCompanionTools(ctx, { deny: ['read', '压根不存在'] }, ctx.logger)

  assert.equal(result.applied, true)
  assert.deepEqual(
    ctx.restricted,
    [{ deny: ['read', '压根不存在'] }],
    '精确名原样下发——本地名单不完整，过滤它才是 bug',
  )
  assert.deepEqual(result.unmatched, [], '精确名不算 unmatched（那是通配的概念）')
})

/* ------------------------------------------------------------------ *
 * runtime-context 屏蔽（伙伴级，2026-09-28 新增）
 *
 * 纯聊天伙伴不需要"你在哪个工作区、能改哪些文件"那一大段。
 * 官方 API：`ctx.systemPrompt.suppressRuntimeContext()`
 * （dsh-system-prompt/lib/index.js:276），效果同极简模式的
 * `includeRuntimeContext: false`（minimal.patch.yml:16）。
 *
 * 三个性质要锁：① 配了才屏蔽；② 没配不屏蔽；③ 换目录/撤销时要撤干净
 * （它和 section 一样挂在 agent scope 上，不撤会在切换后继续生效）。
 * ------------------------------------------------------------------ */

test('runtime-context：伙伴配了 suppressRuntimeContext 才屏蔽', () => {
  const { mkdtempSync, writeFileSync } = require('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'companion-rc-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    name: '聊天', suppressRuntimeContext: true,
  }), 'utf8')

  const ctx = makeCtx()
  const ctl = injectCompanionPrompt(ctx, dir, () => ({}))
  assert.equal(ctx.suppressors.count, 1, '配了 true 应装一个屏蔽')
  ctl.dispose()
  assert.equal(ctx.suppressors.count, 0, 'dispose 后必须撤掉')
})

test('runtime-context：没配（或配 false / 非布尔）都不屏蔽', () => {
  const { mkdtempSync, writeFileSync } = require('node:fs')
  for (const cfg of [
    { name: 'x' },                    // 没配
    { name: 'x', suppressRuntimeContext: false },
    { name: 'x', suppressRuntimeContext: 'true' },   // 非布尔 = 没配
    { name: 'x', suppressRuntimeContext: 1 },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), 'companion-rc-off-'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(cfg), 'utf8')
    const ctx = makeCtx()
    const ctl = injectCompanionPrompt(ctx, dir, () => ({}))
    assert.equal(ctx.suppressors.count, 0, `${JSON.stringify(cfg)} 不该屏蔽`)
    ctl.dispose()
  }
})

test('runtime-context：refresh 换到不屏蔽的伙伴时必须撤掉旧的', () => {
  /*
   * 这条很关键 —— 与工具收窄同一个教训：
   * 屏蔽挂在 agent scope 的 layer 上，**不随换目录自动消失**。
   * 不撤的话，"从聊天伙伴换到普通伙伴"后工作区信息仍然不显示。
   */
  const { mkdtempSync, writeFileSync } = require('node:fs')
  const on = mkdtempSync(join(tmpdir(), 'companion-rc-on-'))
  const off = mkdtempSync(join(tmpdir(), 'companion-rc-off2-'))
  writeFileSync(join(on, 'settings.json'), JSON.stringify({ name: 'A', suppressRuntimeContext: true }), 'utf8')
  writeFileSync(join(off, 'settings.json'), JSON.stringify({ name: 'B' }), 'utf8')

  const ctx = makeCtx()
  const ctl = injectCompanionPrompt(ctx, on, () => ({}))
  assert.equal(ctx.suppressors.count, 1, '前置：A 已屏蔽')

  ctl.refresh(off)
  assert.equal(ctx.suppressors.count, 0, '换到 B（不屏蔽）后必须撤掉——否则 B 也看不到工作区信息')

  ctl.refresh(on)
  assert.equal(ctx.suppressors.count, 1, '切回 A 应重新装上')
  ctl.dispose()
  assert.equal(ctx.suppressors.count, 0, '最终 dispose 归零')
})
