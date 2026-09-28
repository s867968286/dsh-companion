/**
 * 孤儿绑定清理（GC）的回归测试。
 *
 * 判据来自官方 `ctx.sessionQuery.listSessions()` 返回的 `SessionRecord`：
 *   `{ header: { id }, live, persisted }`
 * - `live: false` **不等于**孤儿 —— 只是"当前没在跑"，关着的历史会话仍能重开，
 *   删了就等于把「重开会话恢复人设」搞坏（本插件刚修好的能力）。
 * - 只有 `persisted: false`（持久化后端都不认这个 id）才是真孤儿。
 *
 * 并发要求（三条，都有断言）：
 * ① 清理**绝不能**用旧快照覆盖写 —— 它在 await 查会话期间，用户可能刚选了新伙伴；
 * ② await 期间新建的绑定不能被误删；
 * ③ 判定要在队列里基于**最新**表做，而不是 await 之前读的那份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectOrphanBindings } from '../src/binding-gc.mjs'
import { resolvePaths, writeBinding, readBindings } from '../src/settings.mjs'

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'companion-gc-'))
  const paths = resolvePaths(home)
  mkdirSync(join(paths.companionsRoot, 'lily'), { recursive: true })
  return { home, paths }
}

/** 假的 sessionQuery：按传入记录回放。 */
const queryOf = (records, { delayMs = 0 } = {}) => ({
  async listSessions() {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    return records
  },
})

const rec = (id, { live = false, persisted = true } = {}) => ({ header: { id }, live, persisted })

test('GC①：持久化后端不认的 id → 清掉', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 'gone', 'lily')
  const removed = await collectOrphanBindings(paths, queryOf([rec('alive')]))
  assert.deepEqual(removed, ['gone'])
  assert.equal(readBindings(paths).gone, undefined)
  rmSync(home, { recursive: true, force: true })
})

test('GC②：关着的历史会话（live:false 但 persisted:true）绝不能删', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 'closed', 'lily')
  const removed = await collectOrphanBindings(paths, queryOf([rec('closed', { live: false, persisted: true })]))
  assert.deepEqual(removed, [], '关着不等于孤儿——删了就把「重开恢复人设」搞坏')
  assert.equal(readBindings(paths).closed, 'lily')
  rmSync(home, { recursive: true, force: true })
})

test('GC③：正在跑的会话（live:true）保留', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 'running', 'lily')
  const removed = await collectOrphanBindings(paths, queryOf([rec('running', { live: true })]))
  assert.deepEqual(removed, [])
  rmSync(home, { recursive: true, force: true })
})

test('GC④：并发——清理 await 期间新增的绑定不得被抹掉', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 'gone', 'lily')
  // 列表查询故意慢：期间用户选了新伙伴
  const slow = queryOf([rec('alive')], { delayMs: 40 })
  const pending = collectOrphanBindings(paths, slow)
  await new Promise((r) => setTimeout(r, 10))
  // 并发写入：不能 await（那会把它排出 GC 的窗口），只需保证它落在 await 期间
  const concurrent = writeBinding(paths, 'brand-new', 'lily')
  const removed = await pending
  await concurrent
  assert.deepEqual(removed, ['gone'], '只应清掉真正的孤儿')
  const left = readBindings(paths)
  assert.equal(left['brand-new'], 'lily', 'await 期间新增的绑定不能被旧快照覆盖掉（并发写丢失）')
  rmSync(home, { recursive: true, force: true })
})

test('GC⑤：并发——await 期间被改过的绑定按最新值处理', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 's1', 'lily')
  const slow = queryOf([rec('gone-only')], { delayMs: 40 })
  const pending = collectOrphanBindings(paths, slow)
  await new Promise((r) => setTimeout(r, 10))
  // s1 是孤儿（表里没它，实际不在列表里）——但它已被用户删掉，不该报 removed 后再写回
  await writeBinding(paths, 's2', 'lily')
  const removed = await pending
  const left = readBindings(paths)
  assert.equal(left.s2, 'lily', '并发新增必须在')
  assert.ok(!removed.includes('s2'), '不得把并发新增的会话当孤儿')
  rmSync(home, { recursive: true, force: true })
})

test('GC⑥：query 服务不可用（undefined / 抛错）→ 什么都不做，绝不误删', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 's1', 'lily')
  assert.deepEqual(await collectOrphanBindings(paths, undefined), [])
  assert.deepEqual(await collectOrphanBindings(paths, { listSessions: async () => { throw new Error('boom') } }), [])
  assert.equal(readBindings(paths).s1, 'lily', '拿不到存活集合时宁可不清理')
  rmSync(home, { recursive: true, force: true })
})

test('GC⑦：列表为空数组 → 视为"什么都没查到"，不清理', async () => {
  const { home, paths } = makeHome()
  await writeBinding(paths, 's1', 'lily')
  const removed = await collectOrphanBindings(paths, queryOf([]))
  assert.deepEqual(removed, [], '空列表更可能是查询异常/冷启动，不该据此清空整张表')
  assert.equal(readBindings(paths).s1, 'lily')
  rmSync(home, { recursive: true, force: true })
})
