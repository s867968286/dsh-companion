/**
 * companion_* 工具目录解析的回归测试（W2）。
 *
 * 锁两件**互相独立**的事，缺一不可：
 *
 * 1. `preset.js` 注册点必须把**函数本身**交给工厂（`factory(dirFor)`），
 *    而不是调用结果（`factory(dirFor())`）——后者在注册那一刻就固化了目录，
 *    blank 窗口内后选伙伴的会话会一直写回落目录。
 * 2. 工厂必须在 **execute 时**用官方传进来的 `exec.agent` 解析目录
 *    （`execute(args, exec)`，见 dsh-agent-loop 的 executeToolCalls：
 *    `exec = { callId, name, arguments, agent, signal }`）。
 *
 * 断言 1 必须真正经过 preset.js 的注册点；只在测试里直接调
 * `createJournalTool(fn)` 是**测不出**注册点写法的（函数照样被调用）——
 * 这一点是本文件曾经的空转教训。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createJournalTool } from '../src/tools.mjs'
import { journalPath, dateKey } from '../src/memory-store.mjs'

const makeDir = () => mkdtempSync(join(tmpdir(), 'companion-w2-'))
const readText = (file) => readFileSync(file, 'utf8')

test('W2：工厂在 execute 时才解析目录，且能拿到 exec.agent（后选伙伴命中新目录）', async () => {
  const dirFallback = makeDir()
  const dirLily = makeDir()

  let currentDir = dirFallback
  // 契约：工厂拿到的是「取目录函数」，且 execute 时以 exec.agent 为参数调用
  const seen = []
  const dirFor = (agent) => {
    seen.push(agent)
    return currentDir
  }
  const tool = createJournalTool(dirFor)

  const agentA = { session: { id: 's1' } }
  const r1 = await tool.execute({ body: '选择前的内容' }, { agent: agentA })
  assert.match(r1.text, /已写入今天/)
  assert.equal(seen[0], agentA, 'execute 必须把 exec.agent 传给取目录函数（否则无法按会话解析）')
  assert.ok(readText(journalPath(dirFallback, dateKey())).includes('选择前的内容'))

  // 用户在 blank 窗口内选了伙伴：目录切换
  currentDir = dirLily
  const r2 = await tool.execute({ body: '选择后的内容' }, { agent: { session: { id: 's1' } } })
  assert.match(r2.text, /已写入今天/)
  assert.ok(readText(journalPath(dirLily, dateKey())).includes('选择后的内容'), '换绑后应写新目录')
  assert.ok(
    !readText(journalPath(dirFallback, dateKey())).includes('选择后的内容'),
    '不应再写注册时固化的旧目录',
  )

  rmSync(dirFallback, { recursive: true, force: true })
  rmSync(dirLily, { recursive: true, force: true })
})

test('W2：纯字符串目录仍可用（向后兼容，不传 exec 也不炸）', async () => {
  const dir = makeDir()
  const tool = createJournalTool(dir)
  const result = await tool.execute({ body: '兼容路径' })
  assert.match(result.text, /已写入今天/)
  assert.ok(readText(journalPath(dir, dateKey())).includes('兼容路径'))
  rmSync(dir, { recursive: true, force: true })
})
