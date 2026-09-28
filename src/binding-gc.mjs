/**
 * 孤儿绑定清理（GC）：把 `bindings.json` 里指向「已经不存在的会话」的记录清掉。
 *
 * ## 为什么需要
 *
 * 绑定**不再随 `agent/disposed` 清理**（那会让重开会话恢复不了人设，见 index.js），
 * 于是表会随「用过的会话数」一直增长。真正代表"这段关系结束了"的事件只覆盖
 * 两种（切预设、删伙伴），会话被用户彻底删除时没人通知我们 —— 这些残留就是孤儿。
 *
 * ## 孤儿判据（只在官方记录明确说"不在了"时才清）
 *
 * 依据 `ctx.sessionQuery.listSessions()` 返回的 `SessionRecord`：
 * `{ header: { id }, live, persisted }`。
 *
 * - `persisted === true` → **保留**。这覆盖了两种都不该清的情况：
 *   正在跑的会话（live），以及**关着但还能重开的历史会话**（live:false）。
 *   后者尤其要紧：删了它等于把「重开会话恢复人设」这个能力搞坏。
 * - `persisted === false` → 持久化后端都不认这个 id，判为孤儿。
 *
 * 保守原则：**拿不到存活集合就不清理**（服务缺失、抛错、列表为空）。
 * 空列表尤其不能当成"所有会话都没了" —— 冷启动或后端异常都会给出空列表，
 * 据此清空整张表属于灾难性误判。
 *
 * ## 并发（这是本模块最需要小心的地方）
 *
 * 清理是异步的（要先 await 官方查询），而绑定表的写入是「读全表 → 改 → 原子写」。
 * 若在 await 期间用户选了新伙伴、或新建了会话，而清理拿着 **await 之前读的旧快照**
 * 去写回，就会把那些新写入**静默抹掉**（典型的 lost update）。
 *
 * 所以拆成两段：
 * 1. **异步段**（`collectOrphanBindings`）：只 await 查询，算出"哪些 id 不在了"；
 * 2. **同步段**（写回）：放进 `enqueue(bindingsFile, …)` 串行队列，
 *    在队列**内部重新读一次表**，基于最新值删，再原子写。
 *
 * 这样：队列内的读-改-写不会与任何其它写交叠，而重读最新表保证并发新增的记录
 * 不会因为"不在旧快照里"被丢掉。队列里没有 await，用户选伙伴不会被 GC 阻塞。
 */
import { enqueue } from './memory-store.mjs'
import { readBindings, writeBindings } from './settings.mjs'

/**
 * 从官方 sessionQuery 查「当前仍存在的会话 id」集合。
 *
 * @param {object|undefined} sessionQuery - 官方 `ctx.sessionQuery`（可能不存在）。
 * @returns {Promise<Set<string>|null>} null 表示拿不到（调用方应放弃本次清理）。
 */
async function liveSessionIds(sessionQuery) {
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function') return null
  let records
  try {
    records = await sessionQuery.listSessions()
  } catch {
    return null
  }
  if (!Array.isArray(records) || records.length === 0) return null
  const ids = new Set()
  for (const record of records) {
    const id = record?.header?.id
    // persisted:false 是唯一判为孤儿的依据；live 只说明"当前在跑"。
    if (typeof id === 'string' && id !== '' && record.persisted !== false) ids.add(id)
  }
  return ids.size > 0 ? ids : null
}

/**
 * 清理孤儿绑定。
 *
 * @param {object} paths - `resolvePaths()` 的结果。
 * @param {object|undefined} sessionQuery - 官方 `ctx.sessionQuery`。
 * @returns {Promise<string[]>} 实际被清掉的 sessionId 列表（已按最新表写回）。
 */
export async function collectOrphanBindings(paths, sessionQuery) {
  /*
   * 基准快照：**GC 开始那一刻**表里已有的 sessionId。
   *
   * 为什么必须有它：存活集合是 await 查询拿到的，天然是"过去某一刻"的视图；
   * 而 await 期间用户可能刚选完伙伴（新写入一条绑定），那个会话当然不在
   * 旧快照里 —— 若只按"不在存活集合"判孤儿，就会把**刚写的绑定**当成孤儿清掉。
   *
   * 所以孤儿判据是三个条件的交集：在基准快照里 ∩ 不在存活集合里 ∩ 仍在最新表里。
   * 新写入的记录不在基准快照里，天然免疫。
   */
  const baseline = new Set(Object.keys(readBindings(paths)))

  // ── 异步段：只查，不碰绑定表 ──
  const alive = await liveSessionIds(sessionQuery)
  if (alive === null) return []

  // ── 同步段：进队列，在队列内部重读最新表再删，避免旧快照覆盖并发写 ──
  return enqueue(paths.bindingsFile, () => {
    const current = readBindings(paths)
    const next = {}
    const removed = []
    for (const [sessionId, bound] of Object.entries(current)) {
      if (alive.has(sessionId) || !baseline.has(sessionId)) {
        next[sessionId] = bound
      } else {
        removed.push(sessionId)
      }
    }
    if (removed.length > 0) writeBindings(paths, next)
    return removed
  })
}
