/**
 * Host 半（src/index.js）单测：settings.json 读写、伙伴增删查、备份、日记、设置、
 * 以及**预设切换时的按伙伴工具收窄**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SETTINGS,
  archiveAgent,
  apply,
  copyAgent,
  createAgent,
  generateId,
  listAgents,
  listJournal,
  listLegacyAgents,
  migrateAgent,
  nextOrder,
  readAgent,
  readJournal,
  readPresetMeta,
  readSettings,
  resolvePaths,
  writeAgentFile,
  writePresetMeta,
  writeSettings,
} from '../src/index.js'
// 绑定表写入是异步的（共用按路径队列），本组用例要 await。
import { writeBinding } from '../src/settings.mjs'
import { PRESET_FILES, agentCordisTemplate, renderAllTemplates, renderTemplate } from '../src/templates.mjs'
import { DEFAULT_FILES } from '../src/core.js'

/** 建一个临时的 dshHome 并返回 paths。 */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'companion-home-'))
  return { home, paths: resolvePaths(home) }
}

test('resolvePaths：显式 home 优先，DSH_HOME 次之', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:/fake-dsh-home'
  const paths = resolvePaths()
  assert.equal(paths.dshHome, 'C:/fake-dsh-home')
  assert.equal(paths.companionsRoot, join('C:/fake-dsh-home', 'companion', 'companions'))
  assert.equal(paths.backupRoot, join('C:/fake-dsh-home', 'companion', 'companions-backup'))
  assert.equal(paths.legacyPresetsRoot, join('C:/fake-dsh-home', '.agent-presets'))
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
  assert.equal(resolvePaths('D:/explicit').dshHome, 'D:/explicit')
})

test('settings.json 往返：写入 name/description/order，读回一致', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.companionsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  writePresetMeta(dir, { name: '小花', description: '温柔但直接', order: 3 })
  const meta = readPresetMeta(dir)
  assert.equal(meta.name, '小花')
  assert.equal(meta.description, '温柔但直接')
  assert.equal(meta.order, 3)
  assert.equal(meta.tools, undefined, '没配 tools 时必须是 undefined（= 不限制）')
  assert.equal(meta.autoMemory, undefined, '没配 autoMemory 时必须是 undefined（= 跟随全局）')
  rmSync(home, { recursive: true, force: true })
})

test('settings.json：缺失 order 读成 undefined，不是 0', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.companionsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ name: '小花', description: '无 order' }), 'utf8')
  const meta = readPresetMeta(dir)
  assert.equal(meta.order, undefined, '缺 order 必须读成 undefined，写 0 会让它插到最前面')
  assert.equal(meta.name, '小花')
  rmSync(home, { recursive: true, force: true })
})

test('settings.json：损坏/非对象/缺失一律静默返回空配置，绝不抛', () => {
  /*
   * 一个伙伴的元数据坏掉不该让整个伙伴列表读不出来。
   * 旧实现靠 YAML 正则天然容错；换成 JSON.parse 后必须显式接住语法错误。
   */
  const { home, paths } = makeHome()
  const dir = join(paths.companionsRoot, 'broken')
  mkdirSync(dir, { recursive: true })

  writeFileSync(join(dir, 'settings.json'), '{ 这不是 JSON', 'utf8')
  assert.equal(readPresetMeta(dir).name, '', '语法错误 → 空配置而不是抛')
  assert.equal(readPresetMeta(dir).order, undefined)

  writeFileSync(join(dir, 'settings.json'), '"一个字符串"', 'utf8')
  assert.equal(readPresetMeta(dir).name, '', '顶层非对象 → 空配置')

  writeFileSync(join(dir, 'settings.json'), 'null', 'utf8')
  assert.equal(readPresetMeta(dir).name, '', '顶层 null → 空配置')

  rmSync(join(dir, 'settings.json'), { force: true })
  assert.equal(readPresetMeta(dir).name, '', '文件不存在 → 空配置')

  // 列表仍然读得出来（该伙伴以 id 兜底显示）
  const rows = listAgents(paths)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'broken', '无 name 时回落 id')
  rmSync(home, { recursive: true, force: true })
})

test('settings.json：值含冒号/引号/反斜杠/换行都能原样往返', () => {
  /*
   * 旧实现要为此维护 quote/unquote 两个函数；JSON.stringify 自带转义，
   * 这条测试从"验证我们的转义实现"变成"验证我们没有绕开 JSON"。
   */
  const { home, paths } = makeHome()
  const dir = join(paths.companionsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  for (const value of ['带: 冒号', 'has "quotes"', 'back\\slash', 'line\nbreak', "单引号's", 'tab\there']) {
    writePresetMeta(dir, { name: value, description: value, order: 1 })
    const meta = readPresetMeta(dir)
    assert.equal(meta.name, value, `往返失败：${JSON.stringify(value)}`)
    assert.equal(meta.description, value)
  }
  rmSync(home, { recursive: true, force: true })
})

test('settings.json：有值的字段照常写，order 0 也保留', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.companionsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  writePresetMeta(dir, { name: 'x', description: '', order: 0 })
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.equal(parsed.order, 0, 'order 0 必须落盘，不能被当成 falsy 丢掉')
  assert.equal(readPresetMeta(dir).order, 0, 'order 0 必须保留，不能回落 undefined')
  rmSync(home, { recursive: true, force: true })
})

test('settings.json：改昵称不动 tools / autoMemory（设置页不该抹掉手工配置）', () => {
  /*
   * 设置页只提交 name / description；而 tools 与 autoMemory 是用户手工编辑的。
   * 写入必须是**部分更新**：其余键原样保留，否则改一次昵称就把工具收窄和
   * 记忆开关一起抹掉——这正是旧 preset.yml 时代踩过的坑（注释与未知键被抹）。
   */
  const { home, paths } = makeHome()
  const dir = join(paths.companionsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    name: '莉莉',
    description: '温柔但直接',
    order: 3,
    autoMemory: false,
    tools: { allow: ['read', 'web_search'] },
    // 不认识的键：JSON 没有注释要保护，但读写都该无视而不是炸
    unknownKey: 'ignored',
  }, null, 2), 'utf8')

  writePresetMeta(dir, { name: '莉莉2', description: '温柔但直接', order: 3 })
  const meta = readPresetMeta(dir)
  assert.equal(meta.name, '莉莉2', '昵称应被替换')
  assert.equal(meta.autoMemory, false, 'autoMemory 必须原样保留')
  assert.deepEqual(meta.tools, { allow: ['read', 'web_search'] }, 'tools 必须原样保留')
  rmSync(home, { recursive: true, force: true })
})

test('settings.json：autoMemory 只认布尔，写别的类型当没写（跟随全局）', () => {
  /*
   * 猜一个真值比"不覆盖"危险：猜错会让伙伴静默不记忆，或静默狂写日记。
   * 所以 "true" / 1 / null 一律当没配。
   */
  const { home, paths } = makeHome()
  const dir = join(paths.companionsRoot, 'demo')
  mkdirSync(dir, { recursive: true })
  for (const value of ['true', 1, 0, null, {}, []]) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ name: 'x', autoMemory: value }), 'utf8')
    assert.equal(readPresetMeta(dir).autoMemory, undefined, `${JSON.stringify(value)} 不是布尔，应视为没配`)
  }
  for (const value of [true, false]) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ name: 'x', autoMemory: value }), 'utf8')
    assert.equal(readPresetMeta(dir).autoMemory, value, `${value} 是布尔，应原样读回`)
  }
  rmSync(home, { recursive: true, force: true })
})

test('settings.json：缺 order 的伙伴改名后不该被写成 order 0', () => {
  const { home, paths } = makeHome()
  const dir = join(paths.companionsRoot, 'manual')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ name: '手工' }), 'utf8')

  const current = readPresetMeta(dir)
  assert.equal(current.order, undefined, '缺 order 应读成 undefined')
  writePresetMeta(dir, { name: '手工2', description: current.description, order: current.order })

  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.ok(!('order' in parsed), 'order 为 undefined 时不该落键（写 0 会排到最前）')
  assert.equal(readPresetMeta(dir).order, undefined)
  // 排序哨兵：没有 order 的排最后（与官方 order ?? Infinity 一致）
  const rows = listAgents(paths)
  assert.equal(rows[rows.length - 1].id, 'manual', '缺 order 应排在最后')
  rmSync(home, { recursive: true, force: true })
})

test('迁移：preset.yml → settings.json，保留旧文件，字段对齐', () => {
  /*
   * 存量伙伴目录里是 preset.yml。迁移必须：
   * ① 把三个字段搬到 JSON；② **保留旧文件**（用户手工写过的东西留作回滚依据）。
   */
  const { home, paths } = makeHome()
  const dir = join(paths.companionsRoot, 'legacy')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'preset.yml'), [
    '# 手工注释',
    'name: 莉莉',
    'description: 温柔但直接',
    'order: 3',
    'tools:',
    '  deny:',
    '    - mnemon*',
    '',
  ].join('\n'), 'utf8')

  const meta = readPresetMeta(dir)
  assert.equal(meta.name, '莉莉', '迁移前应能回落读 preset.yml')
  assert.equal(meta.description, '温柔但直接')
  assert.equal(meta.order, 3)

  // 触发迁移（listAgents 会对每个伙伴目录调用迁移）
  listAgents(paths)
  const parsed = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
  assert.equal(parsed.name, '莉莉')
  assert.equal(parsed.description, '温柔但直接')
  assert.equal(parsed.order, 3)
  assert.ok(existsSync(join(dir, 'preset.yml')), '旧文件必须保留，作回滚依据')
  assert.equal(readPresetMeta(dir).name, '莉莉', '迁移后仍读得到')

  // 幂等：再跑一次不改动已存在的 settings.json
  const before = readFileSync(join(dir, 'settings.json'), 'utf8')
  listAgents(paths)
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), before, '迁移必须幂等')

  // 已有 settings.json 时的覆盖保护：不再被 preset.yml 回改
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ name: '新名字' }), 'utf8')
  listAgents(paths)
  assert.equal(readPresetMeta(dir).name, '新名字', 'settings.json 优先，不被旧文件覆盖')
  rmSync(home, { recursive: true, force: true })
})

test('nextOrder：跳过缺 order 的伙伴，不产生巨大序号', () => {
  const { home, paths } = makeHome()
  const a = createAgent(paths, { name: 'A' })   // order 0
  const b = createAgent(paths, { name: 'B' })   // order 1
  const orphan = join(paths.companionsRoot, 'orphan')
  mkdirSync(orphan, { recursive: true })
  writeFileSync(join(orphan, 'preset.yml'), 'name: 外部创建\n', 'utf8') // 无 order

  assert.equal(nextOrder(paths), 2, '不能被无 order 的伙伴顶成 MAX_SAFE_INTEGER 级别')
  const c = createAgent(paths, { name: 'C' })
  assert.equal(readPresetMeta(join(paths.companionsRoot, c.id)).order, 2)
  rmSync(home, { recursive: true, force: true })
})

test('generateId：ASCII 名转 slug，中文名回落 companion-', () => {
  assert.match(generateId('Little Cat', new Set()), /^little-cat-[0-9a-f]{4}$/)
  assert.match(generateId('小花', new Set()), /^companion-[0-9a-f]{4}$/)
  const existing = new Set()
  const first = generateId('a', existing)
  existing.add(first)
  assert.notEqual(generateId('a', existing), first)
})

test('createAgent：生成 6 个 MD + settings.json + memory 目录', () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: '小花', description: '温柔但直接' })
  assert.equal(agent.name, '小花')
  assert.equal(agent.description, '温柔但直接')
  for (const { file } of PRESET_FILES) {
    assert.equal(typeof agent.files[file], 'string', `${file} 应有内容`)
    assert.ok(existsSync(join(paths.companionsRoot, agent.id, file)), `${file} 应落盘`)
  }
  assert.ok(existsSync(join(paths.companionsRoot, agent.id, 'memory')))
  assert.ok(existsSync(join(paths.companionsRoot, agent.id, 'settings.json')))

  assert.ok(agent.files['IDENTITY.md'].includes('小花'))
  rmSync(home, { recursive: true, force: true })
})

test('createAgent：空昵称拒绝', () => {
  const { home, paths } = makeHome()
  assert.throws(() => createAgent(paths, { name: '   ' }), /请输入昵称/)
  rmSync(home, { recursive: true, force: true })
})

test('renderTemplate：昵称/用户名里的 $ 不被当成替换模式', () => {
  // String.replaceAll 的替换串里 $& / $1 / $` 有特殊含义，会把 {name} 字面量吐回来
  for (const name of ['A$&B', 'A$$B', 'A$1B', "A$'B", 'A$`B']) {
    const text = renderTemplate('IDENTITY.md', { name, userName: '鹏哥' })
    assert.ok(text.includes(`你是 ${name}，鹏哥 的个人助手。`), `昵称 ${name} 应原样写入`)
    assert.ok(!text.includes('{name}'), `昵称 ${name} 不该让 {name} 残留`)
  }
  const user = renderTemplate('USER.md', { name: 'n', userName: 'A$&B' })
  assert.ok(user.includes('A$&B'))
  assert.ok(!user.includes('{user}'))

  // 正常中文昵称不受影响
  const normal = renderTemplate('IDENTITY.md', { name: '莉莉', userName: '鹏哥' })
  assert.ok(normal.includes('你是 莉莉，鹏哥 的个人助手。'))
})

test('renderAllTemplates / agentCordisTemplate：模板都能渲染，不留占位符', () => {
  const all = renderAllTemplates({ name: '测试', userName: '老王' })
  assert.deepEqual(Object.keys(all).sort(), PRESET_FILES.map((item) => item.file).sort())
  for (const [file, text] of Object.entries(all)) {
    assert.ok(!text.includes('{name}'), `${file} 不应残留 {name}`)
    assert.ok(!text.includes('{user}'), `${file} 不应残留 {user}`)
  }
  /*
   * agent.cordis.yml 模板**不带**昵称占位符：昵称由 preset.yml 与 IDENTITY.md 承载，
   * 预设行文件只是插件行清单（与线上预设逐字节一致，便于对照）。
   * 所以这里断言它被完整读出、且同样不含残留占位符。
   */
  const cordis = agentCordisTemplate('测试')
  assert.ok(cordis.includes('- id: companion'), 'cordis 模板应含 companion 行')
  assert.ok(!cordis.includes('{name}'), 'cordis 模板不应残留 {name}')
  assert.ok(!cordis.includes('{user}'), 'cordis 模板不应残留 {user}')
})

test('agent.cordis.yml 模板是人格类预设：不含编码 agent 的重型机械，也不挂 persona', () => {
  /*
   * 这是**有意的取舍**，不是遗漏：人格类预设只需要对话的基础工具，
   * plan mode / compaction / 委派与工作流 / goal / jobs 那套重型机械会把
   * 工具目录撑大、并诱导模型走工程流程，对陪伴场景是负担。
   *
   * 这条锁住取舍本身——将来有人「顺手对齐官方 standard」时会被挡下，
   * 要改就得先改这里和模板注释（以及 README）。
   */
  const text = agentCordisTemplate('测试')
  const ids = [...text.matchAll(/^- id:[ \t]*(\S+)/gm)].map((m) => m[1])

  // 基础工具必须在
  for (const id of ['companion', 'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-skill', 'tool-ask-user', 'tool-todo', 'tool-web']) {
    assert.ok(ids.includes(id), `人格类预设应保留基础工具 ${id}`)
  }

  // 重型机械不该在
  for (const id of ['planning', 'plan-mode', 'compaction', 'delegation', 'tool-subagent', 'tool-workflow', 'tool-ralph', 'tool-jobs', 'tool-goal', 'command-goal']) {
    assert.ok(!ids.includes(id), `人格类预设不该挂 ${id}（重型机械，见模板注释）`)
  }

  // 不挂 persona：官方 persona 的 "You are a coding agent ..." 会盖掉人格
  assert.ok(!ids.includes('persona'), '人格由 SYSTEM.md / IDENTITY.md 承载，不挂官方 persona 行')

  // companion 行要带工具收窄配置（关掉第三方记忆插件的工具）
  assert.match(text, /- id: companion[\s\S]{0,200}deny:/, 'companion 行应带 tools.deny 收窄')
  assert.match(text, /'mnemon\*'/, '应关掉 mnemon 的工具，避免两套记忆系统打架')
})

test('listAgents：按 order 升序', () => {
  const { home, paths } = makeHome()
  const a = createAgent(paths, { name: 'A' })
  const b = createAgent(paths, { name: 'B' })
  const rows = listAgents(paths)
  assert.deepEqual(rows.map((row) => row.id), [a.id, b.id])
  rmSync(home, { recursive: true, force: true })
})

test('writeAgentFile：白名单内可写，白名单外拒绝', async () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'X' })
  await writeAgentFile(paths, agent.id, 'SOUL.md', '# 个性\n\n- 新内容\n')
  assert.equal(readAgent(paths, agent.id).files['SOUL.md'], '# 个性\n\n- 新内容\n')
  assert.throws(() => writeAgentFile(paths, agent.id, 'secrets.txt', 'x'), /不允许写/)
  assert.throws(() => writeAgentFile(paths, agent.id, '../evil.md', 'x'), /不允许写/)
  rmSync(home, { recursive: true, force: true })
})

test('archiveAgent：移动到备份目录，原目录消失、备份保留内容', async () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'Y' })
  const result = await archiveAgent(paths, agent.id, new Date(2026, 8, 9, 10, 30, 5))
  assert.ok(result.archived.startsWith(paths.backupRoot))
  assert.ok(result.archived.endsWith(`${agent.id}-20260909-103005`))
  assert.ok(!existsSync(join(paths.companionsRoot, agent.id)))
  assert.ok(existsSync(join(result.archived, 'SOUL.md')))
  assert.deepEqual(listAgents(paths), [])
  rmSync(home, { recursive: true, force: true })
})

test('copyAgent：克隆伙伴内容、替换名字、不带历史日记、order 排末尾', async () => {
  const { home, paths } = makeHome()
  const source = createAgent(paths, { name: '莉莉', description: '温柔但直接' })
  // 制造差异内容与日记，验证「复制内容、不复制日记」
  await writeAgentFile(paths, source.id, 'SOUL.md', '# 个性\n\n你是莉莉的专属灵魂，话少直接。\n')
  await writeAgentFile(paths, source.id, 'IDENTITY.md', '# 身份\n\n你是 莉莉，鹏哥 的个人助手。\n')
  const dir = join(paths.companionsRoot, source.id, 'memory')
  writeFileSync(join(dir, '2026-09-08.md'), '私密日记', 'utf8')

  const copy = copyAgent(paths, source.id, { name: '莉莉二号' })
  assert.equal(copy.name, '莉莉二号')
  assert.equal(copy.description, '温柔但直接')
  assert.notEqual(copy.id, source.id)
  assert.ok(copy.files['SOUL.md'].includes('莉莉二号'), '复制内容应替换源名字')
  assert.ok(copy.files['IDENTITY.md'].includes('莉莉二号'))
  assert.ok(!copy.files['IDENTITY.md'].includes('你是 莉莉，'), '不应残留源名字')

  // 不带历史日记（新建的 memory 目录为空）
  assert.ok(existsSync(join(paths.companionsRoot, copy.id, 'memory')))
  assert.deepEqual(listJournal(paths, copy.id), [])

  // order 排在源之后
  const rows = listAgents(paths)
  assert.deepEqual(rows.map((row) => row.id), [source.id, copy.id])
  rmSync(home, { recursive: true, force: true })
})

test('copyAgent：空昵称回落「xxx 的副本」、源不存在拒绝', () => {
  const { home, paths } = makeHome()
  const source = createAgent(paths, { name: '原版' })
  const copy = copyAgent(paths, source.id, {})
  assert.equal(copy.name, '原版 的副本')
  assert.throws(() => copyAgent(paths, 'nope', { name: 'x' }), /伙伴不存在/)
  assert.throws(() => copyAgent(paths, '../x', { name: 'x' }), /非法 id/)
  rmSync(home, { recursive: true, force: true })
})

test('listJournal / readJournal：按日期倒序，非法日期拒绝', () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'Z' })
  const dir = join(paths.companionsRoot, agent.id, 'memory')
  writeFileSync(join(dir, '2026-09-08.md'), '# 2026-09-08\n\n## 09:00\n\n聊了 A\n', 'utf8')
  writeFileSync(join(dir, '2026-09-09.md'), '# 2026-09-09\n\n## 10:00\n\n聊了 B\n', 'utf8')
  writeFileSync(join(dir, 'notes.md'), '忽略我', 'utf8')

  const rows = listJournal(paths, agent.id)
  assert.deepEqual(rows.map((row) => row.date), ['2026-09-09', '2026-09-08'])
  assert.ok(rows[0].preview.includes('聊了 B'))
  assert.ok(readJournal(paths, agent.id, '2026-09-08').includes('聊了 A'))
  assert.throws(() => readJournal(paths, agent.id, '../etc'), /非法日期/)
  rmSync(home, { recursive: true, force: true })
})

test('listJournal / readJournal：非法 id 也拒绝（防路径穿越）', () => {
  const { home, paths } = makeHome()
  for (const bad of ['..', '../x', 'a/../b', 'a b', '']) {
    assert.throws(() => listJournal(paths, bad), /非法 id/, `listJournal 应拒绝 ${JSON.stringify(bad)}`)
    assert.throws(() => readJournal(paths, bad, '2026-09-09'), /非法 id/, `readJournal 应拒绝 ${JSON.stringify(bad)}`)
  }
  rmSync(home, { recursive: true, force: true })
})

test('createAgent：新建伙伴立刻可被 listAgents 看到（无需重启/装包）', () => {
  /*
   * 这条锁的是本轮的架构取舍：伙伴不再是"官方预设"，所以新建**不需要**
   * 装 bundle、不需要重启 dsh —— 写完文件立刻出现在伙伴列表里。
   *
   * 反面：旧做法要生成 bundle 声明并走安装流程，新建一个伙伴 = 跑 pnpm + 重启。
   * 现在换了落点，这条断言就是那个取舍的守卫。
   */
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'W', description: '即插即用' })
  const listed = listAgents(paths)
  assert.equal(listed.length, 1, '新建后应立刻出现在列表里')
  assert.equal(listed[0].id, agent.id)
  assert.equal(listed[0].name, 'W')
  assert.equal(listed[0].description, '即插即用')
  rmSync(home, { recursive: true, force: true })
})

test('writeAgentFile：写入走串行队列，await 后内容已落盘', async () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'Q' })
  await writeAgentFile(paths, agent.id, 'MEMORY.md', '一')
  await writeAgentFile(paths, agent.id, 'MEMORY.md', '二')
  assert.equal(readAgent(paths, agent.id).files['MEMORY.md'], '二')

  // 并发写同一文件不能互相覆盖成半成品
  await Promise.all([
    writeAgentFile(paths, agent.id, 'MEMORY.md', 'A'),
    writeAgentFile(paths, agent.id, 'MEMORY.md', 'B'),
    writeAgentFile(paths, agent.id, 'MEMORY.md', 'C'),
  ])
  assert.equal(readAgent(paths, agent.id).files['MEMORY.md'], 'C')
  rmSync(home, { recursive: true, force: true })
})

test('writeAgentFile：非法 id / 白名单外仍同步抛错', () => {
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: 'R' })
  assert.throws(() => writeAgentFile(paths, '../x', 'MEMORY.md', 'x'), /非法 id/)
  assert.throws(() => writeAgentFile(paths, agent.id, 'notes.txt', 'x'), /不允许写/)
  assert.throws(() => writeAgentFile(paths, agent.id, '../evil.md', 'x'), /不允许写/)
  // 设置页有 6 个 TAB，Host 端允许写这 6 个文件（白名单来自 PRESET_FILES）；
  // 只有「AI 自动记忆」才被限制在 4 个文件内（见 memory-store 的 EDITABLE_FILES）
  assert.doesNotThrow(() => writeAgentFile(paths, agent.id, 'SYSTEM.md', 'x'))
  rmSync(home, { recursive: true, force: true })
})

test('三条文件清单必须一致：core.DEFAULT_FILES / templates.PRESET_FILES / client.MD_TABS', () => {
  /*
   * 「六个 MD 文件」这份清单在源码里存在**三处**：
   *   src/core.js:37   DEFAULT_FILES    —— 拼系统提示词用（只要文件名）
   *   src/templates.mjs PRESET_FILES    —— 生成模板 + Host 白名单（文件 + 中文标签）
   *   client/client.js  MD_TABS         —— 设置页页签（文件 + 中文标签）
   *
   * 三处各写一份、谁都不锁谁。实测后果：把 client 的 `AGENTS.md` 改成
   * `AGENTS_TYPO.md`，159 条测试**全部通过**——设置页会去读一个不存在的文件，
   * 而没有任何测试能发现。这正是「同一份数据多处硬编码」的典型代价。
   *
   * 这条把三者锁在一起：任一处漂移、增删文件、或顺序错位都会立刻红。
   */
  const clientSource = readFileSync(
    new URL('../client/client.js', import.meta.url), 'utf8',
  )
  const tabs = [...clientSource.matchAll(/\{ file: '([A-Z]+\.md)', label: '([^']+)' \}/g)]
    .map((m) => ({ file: m[1], label: m[2] }))

  assert.deepEqual(
    tabs.map((t) => t.file),
    DEFAULT_FILES,
    'client 的页签文件必须与 core.DEFAULT_FILES 完全一致（含顺序）',
  )
  assert.deepEqual(
    PRESET_FILES.map((item) => item.file),
    DEFAULT_FILES,
    'templates.PRESET_FILES 必须与 core.DEFAULT_FILES 一致',
  )
  assert.deepEqual(
    tabs,
    PRESET_FILES.map((item) => ({ file: item.file, label: item.label })),
    'client 的页签标签必须与 templates.PRESET_FILES 一致（否则设置页与模板文案会打架）',
  )
})

test('设置：缺失回落默认、部分更新只改给到的键', () => {
  const { home, paths } = makeHome()
  assert.deepEqual(readSettings(paths), DEFAULT_SETTINGS)

  const next = writeSettings(paths, { reviewTurns: 20, autoMemory: false })
  assert.equal(next.reviewTurns, 20)
  assert.equal(next.autoMemory, false)
  assert.equal(next.reviewChars, DEFAULT_SETTINGS.reviewChars)
  assert.deepEqual(readSettings(paths), next)

  writeSettings(paths, { reviewTurns: 5 })
  assert.equal(readSettings(paths).autoMemory, false)
  rmSync(home, { recursive: true, force: true })
})

test('设置：越界/错误类型回落到默认值（0 会让每轮都触发回顾）', () => {
  const { home, paths } = makeHome()

  // 阈值 0 / 负数 / 空串 / 非数字 → 回落默认，不能退化成「每轮都跑 LLM」
  for (const bad of [0, -5, '', 'abc', NaN]) {
    assert.equal(writeSettings(paths, { reviewTurns: bad }).reviewTurns, DEFAULT_SETTINGS.reviewTurns, `reviewTurns=${String(bad)}`)
  }
  assert.equal(writeSettings(paths, { reviewChars: 0 }).reviewChars, DEFAULT_SETTINGS.reviewChars)
  assert.equal(writeSettings(paths, { reviewChars: -1 }).reviewChars, DEFAULT_SETTINGS.reviewChars)

  // 布尔键只接受真布尔：字符串 "false" 是真值，会让开关静默失效
  assert.equal(writeSettings(paths, { autoMemory: 'false' }).autoMemory, DEFAULT_SETTINGS.autoMemory)
  assert.equal(writeSettings(paths, { budgetNotice: 'no' }).budgetNotice, DEFAULT_SETTINGS.budgetNotice)

  // 已移除的开关（freeze / complete）不该再出现在设置里 —— 传了也不落盘
  const afterRemoved = writeSettings(paths, { freeze: true, complete: true })
  assert.ok(!('freeze' in afterRemoved), 'freeze 已移除，不该被写入设置')
  assert.ok(!('complete' in afterRemoved), 'complete 已移除，不该被写入设置')

  // 合法值正常生效，小数向下取整
  assert.equal(writeSettings(paths, { reviewTurns: 7.9 }).reviewTurns, 7)
  assert.equal(writeSettings(paths, { reviewTurns: 1 }).reviewTurns, 1)
  assert.equal(writeSettings(paths, { autoMemory: false }).autoMemory, false)

  // 磁盘上被手工写脏的值，读取时也要被夹回来
  writeFileSync(paths.settingsFile, JSON.stringify({ reviewTurns: 0, autoMemory: 'false' }), 'utf8')
  const read = readSettings(paths)
  assert.equal(read.reviewTurns, DEFAULT_SETTINGS.reviewTurns)
  assert.equal(read.autoMemory, DEFAULT_SETTINGS.autoMemory)
  rmSync(home, { recursive: true, force: true })
})

test('readAgent：非法 id / 不存在的 id 报错', () => {
  const { home, paths } = makeHome()
  assert.throws(() => readAgent(paths, '../x'), /非法 id/)
  assert.throws(() => readAgent(paths, 'nope'), /伙伴不存在/)
  rmSync(home, { recursive: true, force: true })
})

/* ─────────────────── 伙伴数据搬迁（.agent-presets → companion/companions） ─────────────────── */

test('migrateAgent：把旧位置的伙伴整体搬到新位置，内容一字不动', () => {
  /*
   * 为什么必须搬：rc2 起官方完全不再读 `.agent-presets/`，把伙伴留在那里
   * 会让人误以为"它是官方预设"，实际官方根本不看。搬走后该目录是纯粹的本插件数据。
   * 本用例断言"只移动、不改内容"——人格与日记一个字都不能变。
   */
  const { home, paths } = makeHome()
  const id = 'legacy-1'
  const from = join(paths.legacyPresetsRoot, id)
  mkdirSync(join(from, 'memory'), { recursive: true })
  writeFileSync(join(from, 'preset.yml'), 'name: 旧伙伴\ndescription: 迁移测试\norder: 7\n', 'utf8')
  writeFileSync(join(from, 'SOUL.md'), '# 灵魂\n这是人格，迁移不该动它。\n', 'utf8')
  writeFileSync(join(from, 'memory', '2026-09-01.md'), '# 9 月 1 日\n旧日记内容\n', 'utf8')

  assert.deepEqual(listLegacyAgents(paths), [id], '应识别出旧位置的伙伴')

  const result = migrateAgent(paths, id)
  assert.equal(result.migrated, true)

  const to = join(paths.companionsRoot, id)
  assert.ok(existsSync(to), '应搬到新位置')
  assert.ok(!existsSync(from), '旧位置应已清空')

  // 内容一字不动：人格、元数据、日记
  assert.equal(readFileSync(join(to, 'SOUL.md'), 'utf8'), '# 灵魂\n这是人格，迁移不该动它。\n')
  assert.equal(readFileSync(join(to, 'memory', '2026-09-01.md'), 'utf8'), '# 9 月 1 日\n旧日记内容\n')
  assert.equal(readPresetMeta(to).name, '旧伙伴')
  assert.equal(readPresetMeta(to).order, 7)

  // 搬完后不再被列为待迁移；新位置能被正常读出
  assert.deepEqual(listLegacyAgents(paths), [])
  assert.equal(readAgent(paths, id).name, '旧伙伴')

  // 幂等：再迁一次只会说明"新位置已存在"
  assert.equal(migrateAgent(paths, id).migrated, false)
  rmSync(home, { recursive: true, force: true })
})

test('listLegacyAgents：只认真正的伙伴目录，不误报无关目录', () => {
  /*
   * 判据是"目录里有 preset.yml 或六个 MD 之一"——只看目录名会把用户在
   * `.agent-presets/` 下随手建的无关目录（缓存、临时目录）也算成待迁移伙伴。
   */
  const { home, paths } = makeHome()
  mkdirSync(join(paths.legacyPresetsRoot, 'real-one'), { recursive: true })
  writeFileSync(join(paths.legacyPresetsRoot, 'real-one', 'preset.yml'), 'name: 真家伙\n', 'utf8')
  mkdirSync(join(paths.legacyPresetsRoot, 'not-a-partner'), { recursive: true })
  writeFileSync(join(paths.legacyPresetsRoot, 'not-a-partner', 'cache.bin'), 'x', 'utf8')
  mkdirSync(join(paths.legacyPresetsRoot, 'Bad_Id'), { recursive: true })
  writeFileSync(join(paths.legacyPresetsRoot, 'Bad_Id', 'preset.yml'), 'name: 非法id\n', 'utf8')

  assert.deepEqual(listLegacyAgents(paths), ['real-one'])
  rmSync(home, { recursive: true, force: true })
})

test('createAgent / copyAgent：不再产出 bundle 声明（伙伴是插件自己的数据）', () => {
  /*
   * 这是本轮架构调整的核心：伙伴不再是"官方预设"，所以不该再生成
   * cordis.patch.yml / package.json —— 那两样东西只对 bundle 有意义，
   * 留着会让人以为"要装包才能用"，与"新建即用、无需重启"直接矛盾。
   */
  const { home, paths } = makeHome()
  const agent = createAgent(paths, { name: '无声明', description: '签名' })
  const dir = join(paths.companionsRoot, agent.id)
  assert.ok(!existsSync(join(dir, 'cordis.patch.yml')), '不该再有 bundle patch')
  assert.ok(!existsSync(join(dir, 'package.json')), '不该再有 bundle package.json')
  assert.ok(existsSync(join(dir, 'settings.json')), 'settings.json 仍要写（昵称/签名/排序）')

  const copy = copyAgent(paths, agent.id, { name: '副本' })
  const copyDir = join(paths.companionsRoot, copy.id)
  assert.ok(!existsSync(join(copyDir, 'cordis.patch.yml')))
  assert.ok(existsSync(join(copyDir, 'SOUL.md')), '副本仍应带六个 MD')
  assert.equal(readAgent(paths, copy.id).name, '副本')
  rmSync(home, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ *
 * 预设切换路径也要装工具收窄（2026-09-28 实测事故）
 *
 * 事故：一个 09-27 建的历史会话，今天在界面上把预设切成「伙伴模式」——
 * 人设装上了、**工具收窄没生效**，请求头里仍是 34 个工具
 * （含 write / edit / pwsh / mcp__dbx__*）。
 *
 * 两个根因，都在这一组里锁住：
 * ① 收窄当时只注册在 `agent/created`，而这台会话走的是另一条事件
 *    `agent-preset/selected`；
 * ② 那条分支原本用 `injections.has(sessionId)` 做统一 early return ——
 *    会话在 agent/created 时若已带绑定，注入已存在，整段被跳过，
 *    于是**连装上收窄的机会都没有**。
 *
 * 必须经由 host 半真实 apply() + 事件流驱动。直接测
 * restrictCompanionTools() 只能验证函数本身，测不出"哪条路径没接上"。
 * ------------------------------------------------------------------ */

/** host 半的最小 ctx：只实现 apply() 真正用到的东西。 */
function makeHostCtx() {
  const listeners = new Map()
  const restricted = []
  const logs = { info: [], warn: [] }
  return {
    restricted,
    logs,
    baseUrl: undefined,
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    get: () => undefined,
    effect: (fn) => fn(),
    // 路由注册需要：给个空实现即可，本组不验 HTTP
    webServer: { register: () => {} },
    logger: {
      info: (m) => logs.info.push(String(m)),
      warn: (m) => logs.warn.push(String(m)),
    },
    tools: {
      register() {},
      view: () => ({ restrictableNames: new Set(['read', 'web_search', 'ask_user_question', 'write', 'edit', 'pwsh']) }),
      restrict(filter) { restricted.push(filter) },
    },
  }
}

test('预设切换：在既有会话上切到伙伴模式也要装工具收窄（事故回归）', async () => {
  const { home, paths } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const companionDir = join(paths.companionsRoot, 'chatty')
    mkdirSync(companionDir, { recursive: true })
    writePresetMeta(companionDir, { name: '聊天', tools: { allow: ['read', 'web_search', 'ask_user_question'] } })

    const ctx = makeHostCtx()
    apply(ctx, { dshHome: home })

    /*
     * ① 会话先以**标准预设**创建 —— 模拟那台 09-27 的历史会话。
     * `agent/created` 会读会话自报的预设，非 companion-mode 直接 return，
     * 但 agent scope 已在更早一行存进 agentCtxBySession（这是②能工作的前提）。
     */
    const agentCtx = {
      systemPrompt: { section: () => () => {}, variable: () => () => {} },
      tools: ctx.tools,
    }
    const session = {
      id: 's-hist',
      blank: false,
      append: () => {},
      snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'standard-gitbash' } }],
    }
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, {})
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(ctx.restricted, [], '标准预设会话不该收窄')

    // ② 用户绑定这个伙伴
    await writeBinding(paths, 's-hist', 'chatty')

    // ③ 界面把预设切成「伙伴模式」——只触发这个事件
    ctx.emit('agent-preset/selected', 's-hist', 'companion-mode')
    await new Promise((r) => setImmediate(r))

    assert.equal(ctx.restricted.length, 1, '切到伙伴模式必须装上工具收窄（这正是漏掉的那条路径）')
    assert.deepEqual(
      ctx.restricted[0],
      { allow: ['ask_user_question', 'read', 'web_search'] },
      '应下发该伙伴的 allow 白名单（展开后排序），write/edit/pwsh 被挡在外面',
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('预设切换：切走不该装收窄', async () => {
  const { home, paths } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const companionDir = join(paths.companionsRoot, 'chatty')
    mkdirSync(companionDir, { recursive: true })
    writePresetMeta(companionDir, { name: '聊天', tools: { allow: ['read'] } })
    await writeBinding(paths, 's1', 'chatty')

    const ctx = makeHostCtx()
    apply(ctx, { dshHome: home })

    const agentCtx = { systemPrompt: { section: () => () => {}, variable: () => () => {} }, tools: ctx.tools }
    ctx.emit('agent/created', { agent: { session: { id: 's1', blank: true, append: () => {} }, ctx: agentCtx } }, {})
    await new Promise((r) => setImmediate(r))

    const before = ctx.restricted.length
    ctx.emit('agent-preset/selected', 's1', 'standard')
    await new Promise((r) => setImmediate(r))
    assert.equal(ctx.restricted.length, before, '切走不该装收窄')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('伙伴清单配了当前不存在的工具时：不报错、只警告，存在的照常下发', async () => {
  /*
   * 用户诉求：allow 里写了某个工具，但那台机器上没装对应插件（如 find_dsh_plugin
   * 来自 dsh-find-plugin、mcp__dbx__* 来自 MCP）——**不能阻断**，只提示。
   *
   * expand() 只把匹配到的名字放进下发名单，其余进 unmatched，因此递给官方
   * restrict() 的一定是实际存在的名字，不会撞它的"未知工具"校验。
   */
  const { home, paths } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const companionDir = join(paths.companionsRoot, 'chatty')
    mkdirSync(companionDir, { recursive: true })
    writePresetMeta(companionDir, {
      name: '聊天',
      // 后两个是别的插件提供的，这个"部署"里没有
      tools: { allow: ['read', 'find_dsh_plugin', 'x_search'] },
    })
    await writeBinding(paths, 's1', 'chatty')

    const ctx = makeHostCtx()
    apply(ctx, { dshHome: home })

    const agentCtx = { systemPrompt: { section: () => () => {}, variable: () => () => {} }, tools: ctx.tools }
    // 会话说自己跑的就是伙伴模式——否则 agent/created 会在预设判断处 return
    const session = {
      id: 's1',
      blank: true,
      append: () => {},
      snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'companion-mode' } }],
    }
    let threw = false
    try {
      ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, {})
      await new Promise((r) => setImmediate(r))
    } catch {
      threw = true
    }

    assert.equal(threw, false, '配了不存在的工具绝不能抛错')
    /*
     * 语义（2026-09-28 起）：精确名**原样下发**，不管本地名单里有没有。
     *
     * 因为本地名单（`view()` 全局视图）**不完整** —— 它没有预设层的工具。
     * 拿它过滤精确名会把 read/write/web_search 这些合法工具误杀
     * （实测事故：伙伴配 10 项 allow，会话只剩 2 个）。校验交给 restrict 自己，
     * 它的 `view(agentScope)` 才是正确名单。
     */
    assert.deepEqual(
      ctx.restricted,
      [{ allow: ['find_dsh_plugin', 'read', 'x_search'] }],
      '精确名原样下发（本桩的 restrict 不校验名单，所以不存在的名字也照传）',
    )
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('预设切换：注入【已存在】时收窄仍必须装上（共用守卫的回归）', async () => {
  /*
   * ⚠️ 这条才是真实事故现场。
   *
   * 上一条测试里，会话在 agent/created 时报的是 standard → 早 return →
   * **注入没装** → 切预设时 `injections.has` 为 false → 即便共用同一个守卫
   * 也会放行。所以那条测不出"共用守卫"这个 bug。
   *
   * 真实情形是：会话在 agent/created 时**已经绑了伙伴**（恢复历史会话、
   * 或"先绑伙伴再切预设"的常见次序）→ 注入已装 → `injections.has` 为 true
   * → 共用守卫把整段跳过 → **收窄永远装不上**。
   *
   * 所以这条故意让会话自报 companion-mode（即走装注入那条分支），
   * 再触发切换事件，断言收窄仍然被调用。
   */
  const { home, paths } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const companionDir = join(paths.companionsRoot, 'chatty')
    mkdirSync(companionDir, { recursive: true })
    writePresetMeta(companionDir, { name: '聊天', tools: { allow: ['read'] } })
    // 会话在创建前就已绑定 —— 这正是注入会在 agent/created 时装上的原因
    await writeBinding(paths, 's-bound', 'chatty')

    const ctx = makeHostCtx()
    apply(ctx, { dshHome: home })

    const agentCtx = { systemPrompt: { section: () => () => {}, variable: () => () => {} }, tools: ctx.tools }
    const session = {
      id: 's-bound',
      blank: true,
      append: () => {},
      snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'companion-mode' } }],
    }
    // agent/created：会话已是伙伴模式 + 已绑伙伴 ⇒ 注入在这里装上
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, {})
    await new Promise((r) => setImmediate(r))
    const afterCreate = ctx.restricted.length

    // 再切一次预设（用户切走又切回，或界面重放选择）
    ctx.emit('agent-preset/selected', 's-bound', 'companion-mode')
    await new Promise((r) => setImmediate(r))

    assert.ok(
      ctx.restricted.length > afterCreate,
      '注入已存在时，切预设分支仍必须装收窄——否则"先绑伙伴的会话"永远收窄不了',
    )
    assert.deepEqual(ctx.restricted.at(-1), { allow: ['read'] })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * 「选伙伴」这一路径也要装工具收窄（2026-09-28 第二次事故）
 *
 * 真实交互次序（从会话日志还原）：
 *   17:06:11  新建会话        → agent/created          绑定表【空】→ 跳过
 *   17:06:13  切到伙伴模式    → agent-preset/selected  绑定仍【空】→ 跳过
 *   17:06:14  选伙伴          → PUT /companion 写绑定    ← 没有任何事件
 *   17:06:18  发请求          → 35 个工具，收窄从未执行
 *
 * 绑定写入本身不触发事件，所以前两条路径全都抢在绑定之前。
 * 只有 PUT /companion（用户表达"用这个伙伴"的那一刻）是正确时机。
 *
 * 之前的测试全部是"先 writeBinding 再 emit 事件"，次序反了，
 * 所以一次都没覆盖到这个真实场景。
 * ------------------------------------------------------------------ */

/** 起一个真 HTTP server + 完整 apply()，返回请求工具。 */
async function withHostServer(home, injectedCtx) {
  const { createServer } = await import('node:http')
  let handler
  // 传 injectedCtx 时用它（例如带真实 restrict 语义的桩），否则用默认的
  const ctx = injectedCtx ?? makeHostCtx()
  // 捕获真实路由 handler（默认实现是空函数）
  ctx.webServer = { register: (route) => { handler = route.handler; return () => {} } }
  apply(ctx, { dshHome: home })
  assert.ok(handler, '应注册路由 handler')

  const server = createServer((req, res) => {
    handler(req, res).catch(() => { res.writeHead(500); res.end('err') })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const call = async (path, options = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}/companion${path}`, {
      method: options.method ?? 'GET',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: res.status, json, text }
  }
  return { ctx, call, close: () => new Promise((r) => server.close(r)) }
}

test('选伙伴（PUT /companion）时必须装工具收窄——真实交互次序的回归', async () => {
  const { home, paths } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let srv
  try {
    const companionDir = join(paths.companionsRoot, 'chatty')
    mkdirSync(companionDir, { recursive: true })
    writePresetMeta(companionDir, { name: '聊天', tools: { allow: ['read', 'web_search'] } })

    srv = await withHostServer(home, makeRestrictCtx())
    const ctx = srv.ctx

    /*
     * ① 新建会话 —— 此刻**绑定表是空的**（这正是真实次序的关键）。
     * 会话说自己是 companion-mode（用户在新会话页选了伙伴模式预设）。
     */
    const agentCtx = { systemPrompt: { section: () => () => {}, variable: () => () => {} }, tools: ctx.tools }
    const session = {
      id: 's-live',
      blank: true,
      append: () => {},
      snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'companion-mode' } }],
    }
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, {})
    await new Promise((r) => setImmediate(r))
    assert.equal(ctx.live.length, 0, '前置：此时还没绑定，不该收窄')

    // ② 切预设（真实场景里紧随创建）
    ctx.emit('agent-preset/selected', 's-live', 'companion-mode')
    await new Promise((r) => setImmediate(r))
    assert.equal(ctx.live.length, 0, '前置：绑定仍为空，仍不该收窄')

    // ③ 用户选伙伴 —— 这才是收窄该发生的时刻
    // 路径要带 /api 段：handler 会先 slice 掉 /companion 前缀，再匹配 /api/companion
    const res = await srv.call('/api/companion', { method: 'PUT', body: { companion: 'chatty', session: 's-live' } })
    assert.equal(res.status, 200, `选伙伴应成功，实际 ${res.status} ${res.text}`)
    await new Promise((r) => setImmediate(r))

    assert.equal(ctx.live.length, 1, '选伙伴必须装工具收窄——否则前两条路径全抢在绑定之前，收窄永远不生效')
    assert.deepEqual(ctx.visible(), ['read', 'web_search'], '只应剩该伙伴 allow 里的两项')
  } finally {
    if (srv) await srv.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * 收窄的**撤销**：换伙伴 / 置空 / 切走（2026-09-28 代码审查发现）
 *
 * 官方 restriction 是**只增不减 + 交集**语义
 * （dsh-tools/lib/index.js:2641-2644 的 admits() 要求每一条都放行）。
 * 我们之前把 `restrict()` 返回的 disposer 丢掉了，于是：
 *
 * - 换伙伴：新旧 allow 取交集 —— 新伙伴多要一个工具也要不到；
 * - 置空「无伙伴」：旧 allow 继续生效，用户以为放开了、实际仍被限制；
 * - 切回官方 standard：官方模式本该全套工具，却仍被我们的 allow 挡着。
 *
 * 修法：按会话存住 disposer，任何切换**先撤后装**。
 * ------------------------------------------------------------------ */

/** 假 ctx：restrict 有真实语义（叠加 + 交集），并支持 disposer 撤销。 */
function makeRestrictCtx() {
  const listeners = new Map()
  const logs = { info: [], warn: [] }
  /** 该会话当前挂着的 restriction 列表（模拟官方 layer 上的只增不减）。 */
  const live = []
  const KNOWN = ['read', 'write', 'web_search', 'pwsh']
  return {
    live,
    logs,
    /** 当前真正可见的工具（交集语义）。 */
    visible: () => KNOWN.filter((name) => live.every((f) => {
      if (f.allow !== undefined && !f.allow.has(name)) return false
      if (f.deny !== undefined && f.deny.has(name)) return false
      return true
    })),
    baseUrl: undefined,
    on(event, handler) { const l = listeners.get(event) ?? []; l.push(handler); listeners.set(event, l); return () => {} },
    emit(event, ...args) { for (const h of listeners.get(event) ?? []) h(...args) },
    get: () => undefined,
    effect: (fn) => fn(),
    webServer: { register: () => {} },
    logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)) },
    tools: {
      register() {},
      view: () => ({ restrictableNames: new Set(KNOWN) }),
      restrict(filter) {
        const compiled = {
          ...filter.allow !== undefined ? { allow: new Set(filter.allow) } : {},
          ...filter.deny !== undefined ? { deny: new Set(filter.deny) } : {},
        }
        live.push(compiled)
        // 官方返回 disposer：撤销这一条
        return () => {
          const i = live.indexOf(compiled)
          if (i >= 0) live.splice(i, 1)
        }
      },
    },
  }
}

/** 建一个伙伴目录（写 settings.json）。 */
function makeCompanion(paths, id, tools) {
  const dir = join(paths.companionsRoot, id)
  mkdirSync(dir, { recursive: true })
  writePresetMeta(dir, { name: id, tools })
  return dir
}

test('换伙伴：新的 allow 必须完全替换旧的，不能与旧名单取交集', async () => {
  const { home, paths } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let srv
  try {
    makeCompanion(paths, 'narrow', { allow: ['read'] })
    makeCompanion(paths, 'wide', { allow: ['read', 'write', 'web_search'] })

    srv = await withHostServer(home, makeRestrictCtx())
    const ctx = srv.ctx
    const agentCtx = { systemPrompt: { section: () => () => {}, variable: () => () => {} }, tools: ctx.tools }
    const session = {
      id: 's-swap', blank: true, append: () => {},
      snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'companion-mode' } }],
    }
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, {})
    await new Promise((r) => setImmediate(r))

    // 选窄伙伴
    let res = await srv.call('/api/companion', { method: 'PUT', body: { companion: 'narrow', session: 's-swap' } })
    assert.equal(res.status, 200)
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(ctx.visible(), ['read'], '窄伙伴应只剩 read')

    // 换成宽伙伴 —— 这一步若与旧名单取交集，write/web_search 永远拿不到
    res = await srv.call('/api/companion', { method: 'PUT', body: { companion: 'wide', session: 's-swap' } })
    assert.equal(res.status, 200)
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(
      ctx.visible(), ['read', 'write', 'web_search'],
      '换伙伴必须整体替换：交集语义下不撤旧的，新伙伴多要的工具会永远拿不到',
    )
    assert.equal(ctx.live.length, 1, '旧 restriction 必须被撤掉，不能叠加')
  } finally {
    if (srv) await srv.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('置空「无伙伴」：必须撤掉旧的收窄，工具恢复全可见', async () => {
  const { home, paths } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let srv
  try {
    makeCompanion(paths, 'narrow', { allow: ['read'] })

    srv = await withHostServer(home, makeRestrictCtx())
    const ctx = srv.ctx
    const agentCtx = { systemPrompt: { section: () => () => {}, variable: () => () => {} }, tools: ctx.tools }
    const session = {
      id: 's-clear', blank: true, append: () => {},
      snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'companion-mode' } }],
    }
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, {})
    await new Promise((r) => setImmediate(r))

    let res = await srv.call('/api/companion', { method: 'PUT', body: { companion: 'narrow', session: 's-clear' } })
    assert.equal(res.status, 200)
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(ctx.visible(), ['read'], '前置：已收窄')

    // 置空
    res = await srv.call('/api/companion', { method: 'PUT', body: { companion: null, session: 's-clear' } })
    assert.equal(res.status, 200, `置空应成功，实际 ${res.status} ${res.text}`)
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(
      ctx.visible(), ['read', 'write', 'web_search', 'pwsh'],
      '置空「无伙伴」后工具应恢复全可见——不撤旧的，用户以为放开了实际仍被限制',
    )
  } finally {
    if (srv) await srv.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('切回官方模式：必须撤掉收窄，官方模式不该被我们的 allow 限制', async () => {
  const { home, paths } = makeHome()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let srv
  try {
    makeCompanion(paths, 'narrow', { allow: ['read'] })

    srv = await withHostServer(home, makeRestrictCtx())
    const ctx = srv.ctx
    const agentCtx = { systemPrompt: { section: () => () => {}, variable: () => () => {} }, tools: ctx.tools }
    const session = {
      id: 's-back', blank: true, append: () => {},
      snapshotEvents: () => [{ type: 'agent-preset/selected', data: { agentPreset: 'companion-mode' } }],
    }
    ctx.emit('agent/created', { agent: { session, ctx: agentCtx } }, {})
    await new Promise((r) => setImmediate(r))
    await srv.call('/api/companion', { method: 'PUT', body: { companion: 'narrow', session: 's-back' } })
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(ctx.visible(), ['read'], '前置：伙伴模式已收窄')

    // 用户把预设切回官方 standard
    ctx.emit('agent-preset/selected', 's-back', 'standard-gitbash')
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(
      ctx.visible(), ['read', 'write', 'web_search', 'pwsh'],
      '切回官方模式后工具必须恢复全可见——restriction 挂在 agent scope 上，不撤会跟着会话一直生效',
    )
  } finally {
    if (srv) await srv.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
