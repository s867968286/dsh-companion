/**
 * dsh-companion 的 Host 半（bundle 行，host 平台）：给「伙伴设置」页面提供
 * HTTP 接口，读写 `<dshHome>/companion/companions/<id>/` 下的文件。
 *
 * 设计约束：
 * - 只读/写伙伴目录与自己的设置文件，不碰别处；
 * - 删除 = 移动到 `<dshHome>/companion/companions-backup/<id>-<时间戳>/`，不真删；
 * - 无第三方依赖：preset.yml 用极简正则读写（只有 name/description/order 三个字段）。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

import { atomicWrite, enqueue, readText } from './memory-store.mjs'
import {
  companionFromEvents,
  injectCompanionPrompt,
  normalizeCompanion,
  recordCompanionSelection,
  restrictCompanionTools,
} from './companion.mjs'
import {
  DEFAULT_SETTINGS,
  deleteBinding,
  deleteBindingsFor,
  readBindings,
  readSettings,
  resolvePaths,
  writeSettings,
} from './settings.mjs'
import { COMPANION_PRESET_ID, companionPresetMeta, companionPresetPlugins } from './companion-preset.mjs'
import { collectOrphanBindings } from './binding-gc.mjs'
import { PRESET_FILES, renderAllTemplates } from './templates.mjs'
import { sessionEvents } from './core.js'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/companion'

export { DEFAULT_SETTINGS, readSettings, resolvePaths, writeSettings }

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const EDITABLE = new Set(PRESET_FILES.map((item) => item.file))

/** 带 status 的错误：业务错误（4xx）与内部错误（500）要分开报，便于排查。 */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * 昵称 / 签名的长度上限（字符）。
 *
 * 存在的理由有两个，都不是「洁癖」：
 * - 昵称会进 `preset.yml` 与 `IDENTITY.md`，签名会进 `preset.yml` 与预设卡片；
 *   而 `listAgents` 每次列表都要整份读每个预设的 `preset.yml`，无上限时
 *   一个超大值就能把设置页拖慢。
 * - 这个接口是暴露在本机 HTTP 上的（来源校验之外的纵深防御），
 *   没有长度上限的写接口等于允许无限膨胀。
 */
export const MAX_NAME_CHARS = 60
export const MAX_DESCRIPTION_CHARS = 200

/** 校验一个文本字段的长度，超限抛 400（HttpError 定义在本文件常量区，可直接用）。 */
function assertLength(value, max, label) {
  const text = String(value ?? '')
  if (text.length > max) throw new HttpError(400, `${label}过长（上限 ${max} 字符，当前 ${text.length}）`)
  return text
}

/* ────────────────────────── preset.yml 读写 ──────────────────────────
 * 不引 YAML 库（保持零依赖），只支持 name / description / order 三个标量字段，
 * 但把「引号转义」和「缺失字段」两件事做对：
 * - 写：值里出现 YAML 特殊字符时才加双引号，且**同时转义 \ 与 "**（不对称转义会篡改数据）；
 *       换行一律转成 \n 转义序列，不让它破坏文件结构。
 * - 读：双引号值走与写对称的反转义；**缺失字段返回 undefined 而不是 0**
 *       （`Number('') === 0` 会让所有没有 order 的伙伴排到最前面）。
 * ------------------------------------------------------------------ */

/**
 * 伙伴元数据文件名。
 *
 * ## 为什么是 JSON 而不是原来的 preset.yml
 *
 * 原先每个伙伴目录里放的是 `preset.yml`——那是从「伙伴即官方预设目录」时代
 * 继承下来的格式（当时归官方 `@deepseek-ai/dsh-agent-presets` 管理，该包在
 * rc2 已不存在，官方全树搜不到读它的代码）。
 *
 * 它带来**三份本可以没有的复杂度**：
 * 1. 手写正则逐行 `pick(key)`，只认三个标量字段；
 * 2. 按行合并写入（`mergePresetMeta`），只为保护注释与不认识的键；
 * 3. YAML 隐式类型化——`order: 2026-09-13` 会被读成 Date 而不是字符串，
 *    于是 `Number(orderText)` 失败、整条 order 丢失、伙伴掉到列表末尾。
 *    为此还要维护 `isPlainSafe` / `looksTyped` / `quote` / `unquote` 四个函数。
 *
 * 换成 JSON 后这四样**全部消失**：`JSON.parse` 自带转义与类型，
 * 没有注释要保护，也没有隐式类型化。文件名与全局设置同名（`settings.json`），
 * 且同样住在 `companion/` 下，心智一致。
 *
 * 兼容：老伙伴目录里的 `preset.yml` 由 `migrateCompanionMeta` 一次性迁移，
 * 迁移后旧文件**保留不删**（用户手工写过的内容留作回滚依据）。
 */
export const META_FILE = 'settings.json'

/** 旧格式元数据文件名，只在迁移与兜底读时使用。 */
export const LEGACY_META_FILE = 'preset.yml'

/**
 * 伙伴自己的设置（住在伙伴目录里）。
 *
 * 与全局 `settings.json`（`~/.dsh/companion/settings.json`）区分：
 * 全局那份是**插件级**开关（设置页管），这一份是**单个伙伴**的覆盖。
 *
 * @typedef {object} CompanionMeta
 * @property {string} name - 昵称（必填，调用方保证非空）。
 * @property {string} description - 签名，可为空串。
 * @property {number|undefined} order - 排序号；缺失排最后（不回落 0）。
 * @property {object|undefined} tools - 工具收窄，见 normalizeToolFilter。
 * @property {boolean|undefined} autoMemory - 覆盖全局自动记忆开关；undefined = 跟随全局。
 */

/**
 * 从任意对象里挑出本插件认识的字段并归一化。
 *
 * 不认识的键**原样丢弃**——JSON 没有注释要保护，也没有「官方将来会读」的顾虑，
 * 与旧 preset.yml 的「按行合并、其余保留」是相反的取舍，这里刻意从简。
 *
 * @param {unknown} raw - JSON.parse 的结果，或调用方传入的部分字段。
 * @returns {CompanionMeta}
 */
export function normalizeMeta(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const name = input.name
  const description = input.description
  const orderValue = input.order
  const order = typeof orderValue === 'number' && Number.isFinite(orderValue)
    ? orderValue
    : (typeof orderValue === 'string' && orderValue.trim() !== '' && Number.isFinite(Number(orderValue))
      ? Number(orderValue)
      : undefined)
  return {
    name: typeof name === 'string' ? name : '',
    description: typeof description === 'string' ? description : '',
    order,
    /*
     * tools 保持原始形态交给 normalizeToolFilter 处理（它在 core.js，
     * 是工具收窄的唯一入口）；这里只在**完全没写**时给 undefined，
     * 以便区分「没配 = 不限制」与「配了空对象」。
     */
    tools: input.tools === undefined || input.tools === null ? undefined : input.tools,
    /*
     * autoMemory 只认布尔。写别的类型（"true" / 1）一律当**没写**，
     * 跟随全局——比猜一个真值安全：猜错会让伙伴静默不记忆或静默狂写。
     */
    autoMemory: typeof input.autoMemory === 'boolean' ? input.autoMemory : undefined,
    /*
     * suppressRuntimeContext：屏蔽官方的 runtime-context 注入块
     * （当前文件策略 / 审批策略 / 工作区信息等一大段）。
     *
     * 对**纯聊天**伙伴有用：那段文字讲的是"你在哪个工作区、能改哪些文件"，
     * 对一个只负责聊天的伙伴既是噪音也占 token。
     * 官方 API 是 `ctx.systemPrompt.suppressRuntimeContext()`
     * （dsh-system-prompt/lib/index.js:276，挂在 agent scope 上）。
     *
     * 与 autoMemory 同一约定：只认布尔，写别的类型当没写（= 不屏蔽）。
     */
    suppressRuntimeContext:
      typeof input.suppressRuntimeContext === 'boolean' ? input.suppressRuntimeContext : undefined,
  }
}

/**
 * 读伙伴自己的设置。
 *
 * 容错策略：文件缺失 / JSON 损坏 / 顶层不是对象，一律当成**空配置**返回
 * （name 空串、其余 undefined），由调用方兜底。绝不抛——一个伙伴的元数据
 * 坏掉不该让整个伙伴列表读不出来。
 *
 * **回落旧格式**：`settings.json` 不存在但 `preset.yml` 在时，读旧文件。
 * 这样即使迁移还没跑（或迁移失败），伙伴也不会突然"没有名字"。
 *
 * @param {string} dir - 伙伴目录。
 * @returns {CompanionMeta}
 */
export function readPresetMeta(dir) {
  const file = join(dir, META_FILE)
  if (!existsSync(file)) {
    const legacy = readLegacyMeta(dir)
    if (legacy !== undefined) return legacy
    return normalizeMeta({})
  }
  let parsed
  try {
    parsed = JSON.parse(readText(file) || '{}')
  } catch {
    return normalizeMeta({})
  }
  return normalizeMeta(parsed)
}

/**
 * 从旧格式 `preset.yml` 里读三个标量字段（够用的极简解析）。
 *
 * 刻意**不解析 `tools`**：旧文件里若有它，保留在 yml 里由用户自己搬过去，
 * 我们不猜 YAML 的嵌套结构——猜错会让工具静默消失或全被挡掉。
 *
 * @param {string} dir - 伙伴目录。
 * @returns {CompanionMeta|undefined} 旧文件不存在时返回 undefined。
 */
function readLegacyMeta(dir) {
  const legacy = join(dir, LEGACY_META_FILE)
  if (!existsSync(legacy)) return undefined
  const text = readText(legacy)
  const pick = (key) => {
    const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text)
    if (!match) return undefined
    const value = match[1].trim()
    // 去引号（旧格式的 quote/unquote 只服务这三个标量，这里够用）
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try { return JSON.parse(value) } catch { return value.slice(1, -1) }
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1)
    return value
  }
  const orderText = pick('order')
  const order = orderText === undefined || orderText === '' ? undefined : Number(orderText)
  return normalizeMeta({
    name: pick('name'),
    description: pick('description'),
    order: Number.isFinite(order) ? order : undefined,
  })
}

/**
 * 写伙伴自己的设置（原子写）。
 *
 * **整份重写**，与该文件「只有本插件读」的定位一致。字段写入规则：
 * - `name` 始终写（调用方保证非空）；
 * - `description` / `order` 为 `undefined` 时不写该键（保持「没设过就不落键」，
 *   与旧实现一致：缺 order 要排最后，写成 0 会让它跳到最前）；
 * - `tools` / `autoMemory` 为 `undefined` 时不写，**已有值原样保留**——
 *   设置页只改昵称/签名，不该顺手把用户手工配的工具收窄抹掉。
 *
 * @param {string} dir - 伙伴目录。
 * @param {Partial<CompanionMeta>} patch - 要更新的字段。
 */
export function writePresetMeta(dir, patch = {}) {
  const prev = readPresetMeta(dir)
  const next = { name: patch.name !== undefined ? patch.name : prev.name }
  const description = patch.description !== undefined ? patch.description : prev.description
  const order = patch.order !== undefined ? patch.order : prev.order
  const tools = patch.tools !== undefined ? patch.tools : prev.tools
  const autoMemory = patch.autoMemory !== undefined ? patch.autoMemory : prev.autoMemory
  const suppressRuntimeContext = patch.suppressRuntimeContext !== undefined
    ? patch.suppressRuntimeContext
    : prev.suppressRuntimeContext

  /*
   * description 为空串时**仍然写**（用户显式清空签名与「从来没设过」是两件事，
   * 与旧实现的约定一致）；只有 undefined 才不落键。
   */
  if (patch.description !== undefined || prev.description !== '') next.description = description
  if (order !== undefined) next.order = order
  if (tools !== undefined) next.tools = tools
  if (autoMemory !== undefined) next.autoMemory = autoMemory
  if (suppressRuntimeContext !== undefined) next.suppressRuntimeContext = suppressRuntimeContext

  atomicWrite(join(dir, META_FILE), `${JSON.stringify(next, null, 2)}
`)
}

/**
 * 把老伙伴目录里的 `preset.yml` 迁成 `settings.json`。
 *
 * 只在 **settings.json 不存在、preset.yml 存在**时动手；迁完**保留旧文件**
 * （用户手工写过的东西留作回滚依据，也符合本插件「删除=归档不真删」的约定）。
 *
 * 旧文件是 YAML，这里用**够用的极简解析**而不是引依赖：只认顶层
 * `key: value` 三个标量键（与旧 readPresetMeta 同能力），遇到看不懂的形态
 * 就跳过——迁移是尽力而为，失败也只是让那个伙伴回落「无元数据」，
 * 不该阻止插件启动。刻意**不解析 tools**：旧文件里若有它，保留在 yml 里
 * 由用户自己搬，我们不猜 YAML 的嵌套结构。
 *
 * @param {string} dir - 伙伴目录。
 * @returns {{migrated: boolean, read?: object}} 是否迁移、以及读到的原始字段。
 */
export function migrateCompanionMeta(dir) {
  const target = join(dir, META_FILE)
  const legacy = join(dir, LEGACY_META_FILE)
  if (existsSync(target) || !existsSync(legacy)) return { migrated: false }

  const meta = readLegacyMeta(dir)
  if (meta === undefined) return { migrated: false }
  try {
    writePresetMeta(dir, {
      name: meta.name,
      description: meta.description,
      order: meta.order,
    })
    return { migrated: true, read: meta }
  } catch {
    return { migrated: false }
  }
}

/** 从名字生成合法 id（中文名回落使用 companion 前缀，一眼可辨是本插件创建的）。 */
export function generateId(name, existing) {
  const slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const base = /^[a-z0-9]/.test(slug) ? slug : 'companion'
  for (let i = 0; i < 32; i += 1) {
    const id = `${base}-${randomUUID().slice(0, 4)}`
    if (!existing.has(id)) return id
  }
  throw new Error('生成 id 冲突次数过多')
}

/**
 * 下一个可用的 order。
 *
 * 只统计**真实存在且有限**的 order（跳过缺字段的伙伴），不用 listAgents 的行值——
 * 那里的 `Number.MAX_SAFE_INTEGER` 是排序哨兵，拿来做 max+1 会算出无意义的巨大序号。
 */
export function nextOrder(paths) {
  if (!existsSync(paths.companionsRoot)) return 0
  let max = -1
  for (const entry of readdirSync(paths.companionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PRESET_ID.test(entry.name)) continue
    const { order } = readPresetMeta(join(paths.companionsRoot, entry.name))
    if (Number.isFinite(order) && order > max && order < Number.MAX_SAFE_INTEGER) max = order
  }
  return max + 1
}

/** 列出全部伙伴（按 order 升序）。 */
export function listAgents(paths) {
  if (!existsSync(paths.companionsRoot)) return []
  const rows = []
  for (const entry of readdirSync(paths.companionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PRESET_ID.test(entry.name)) continue
    const dir = join(paths.companionsRoot, entry.name)
    /*
     * 顺手迁移旧格式元数据（preset.yml → settings.json）。
     *
     * 挂在列表函数里而不是 apply() 里，有两个理由：
     * ① 列表是**唯一必然读到每个伙伴**的入口，覆盖率天然完整；
     * ② 它已经对每个目录做了一次 readdir，迁移判断只多一次 existsSync。
     * 迁移自身幂等（已有 settings.json 就立刻返回），失败静默——坏一个伙伴的
     * 元数据不该让整个列表读不出来。
     */
    migrateCompanionMeta(dir)
    const meta = readPresetMeta(dir)
    rows.push({
      id: entry.name,
      name: meta.name || entry.name,
      description: meta.description,
      order: meta.order ?? Number.MAX_SAFE_INTEGER,
    })
  }
  return rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** 读一个伙伴的全部 MD 内容与元信息。
 *
 *  一并返回每个文件的**版本指纹**（内容哈希），供编辑冲突检测用：
 *  UI 载入时拿到它，保存时原样回传，服务端比对不一致就报 409。 */
export function readAgent(paths, id) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const dir = join(paths.companionsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  const meta = readPresetMeta(dir)
  const files = {}
  const versions = {}
  for (const { file } of PRESET_FILES) {
    const text = readText(join(dir, file))
    files[file] = text
    versions[file] = contentHash(text)
  }
  return {
    id,
    name: meta.name || id,
    description: meta.description,
    files,
    versions,
  }
}

/** 内容指纹（sha256 前 16 位十六进制）：只用于「和载入时是否一致」，不做安全用途。 */
export function contentHash(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 写一个 MD 文件（白名单内）。走 memory-store 的写队列，避免与后台自动记忆
 * 形成「读-改-写」竞态（后台走 enqueue，这里直写会互相覆盖）。
 * 参数校验保持同步抛错，只有真正的写盘是异步的。
 *
 * ## 乐观并发：`baseVersion`
 *
 * 后台自动记忆会往同一个文件追加内容（`runReview` → `applyUpdate`）。
 * 若用户在设置页打开 MEMORY.md 编辑十分钟、期间后台追加了一条记忆，
 * 应用户点保存时若直接整文件覆盖，那条记忆就**静默消失**——两边都不报错。
 *
 * 所以 UI 保存时回传载入时的 `baseVersion`（`readAgent` 给的内容哈希），
 * 这里在写队列**内部**实时比对：不一致就抛 409，让用户重新载入后再决定。
 * 比对必须在队列里做（而不是进队列之前），否则两个并发写会双双读到旧值。
 *
 * 不传 `baseVersion` 时保持旧行为（无校验）——给脚本 / 命令行调用留后路。
 */
export function writeAgentFile(paths, id, file, content, { baseVersion } = {}) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  if (!EDITABLE.has(file)) throw new Error(`不允许写 ${file}`)
  const dir = join(paths.companionsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  const target = join(dir, file)
  const text = String(content ?? '')
  return enqueue(target, () => {
    if (typeof baseVersion === 'string' && baseVersion !== '') {
      const current = contentHash(readText(target))
      if (current !== baseVersion) {
        throw new HttpError(409, `${file} 已被后台修改（例如自动记忆写入），请重新载入后再保存`)
      }
    }
    atomicWrite(target, text)
    return { ok: true, version: contentHash(text) }
  })
}

/**
 * 新建伙伴：生成 id、目录、六个模板 MD、preset.yml、memory/。
 *
 * **不再生成 bundle 声明**（`cordis.patch.yml` / `package.json`）。
 * rc2 起官方预设只能由已安装的 bundle 声明，那意味着"新建伙伴 = 装包 + 重启"，
 * 与"即插即用"不可兼得。伙伴因此回归成本插件自己的数据（`companion/companions/`），
 * 提示词的独占改由 `complete` section 承担（见 core.js 的 registerPrompt）。
 *
 * 因此新建伙伴**无需重启**：写几个文件即可，下拉框立刻能看到。
 */
export function createAgent(paths, { name, description = '', userName = '用户' }) {
  const clean = assertLength(String(name ?? '').trim(), MAX_NAME_CHARS, '昵称')
  if (!clean) throw new Error('请输入昵称')
  const desc = assertLength(String(description ?? ''), MAX_DESCRIPTION_CHARS, '个性签名')
  const user = assertLength(String(userName ?? '').trim() || '用户', MAX_NAME_CHARS, '用户名')
  const id = generateId(clean, existingIds(paths))
  const dir = join(paths.companionsRoot, id)
  mkdirSync(dir, { recursive: true })

  const order = nextOrder(paths)
  writePresetMeta(dir, { name: clean, description: desc || undefined, order })
  for (const [file, content] of Object.entries(renderAllTemplates({ name: clean, userName: user }))) {
    atomicWrite(join(dir, file), content)
  }
  mkdirSync(join(dir, 'memory'), { recursive: true })
  return readAgent(paths, id)
}

/** 现有伙伴 id 集合（供 generateId 去重）。 */
function existingIds(paths) {
  if (!existsSync(paths.companionsRoot)) return new Set()
  return new Set(
    readdirSync(paths.companionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  )
}

/** 复制伙伴：以某伙伴为模板克隆一个同名性格的新伙伴。
 *  保留源的全部 MD，把其中出现的源名字面替换为新昵称；
 *  不带历史日记（memory/ 新建为空），description 沿用、order 排到末尾。 */
export function copyAgent(paths, sourceId, { name } = {}) {
  if (!PRESET_ID.test(sourceId)) throw new Error(`非法 id：${sourceId}`)
  const srcDir = join(paths.companionsRoot, sourceId)
  if (!existsSync(srcDir)) throw new Error(`伙伴不存在：${sourceId}`)
  const sourceMeta = readPresetMeta(srcDir)
  const oldName = sourceMeta.name || sourceId
  const clean = assertLength(String(name ?? '').trim() || `${oldName} 的副本`, MAX_NAME_CHARS, '昵称')
  const id = generateId(clean, existingIds(paths))
  const dir = join(paths.companionsRoot, id)
  mkdirSync(dir, { recursive: true })

  const renameIn = (text) => (oldName === clean ? text : text.split(oldName).join(clean))

  // 复制六个 MD（settings.json 由下方按新名字重写）
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === META_FILE || entry.name === LEGACY_META_FILE) continue
    if (PRESET_FILES.some((item) => item.file === entry.name)) {
      atomicWrite(join(dir, entry.name), renameIn(readText(join(srcDir, entry.name))))
    }
  }

  const order = nextOrder(paths)
  /*
   * description：源有值就沿用，源没有（读成 ''）就**不写这一行**——
   * 遵循「没设过就不落行」的约定（同 order），
   * 避免把一个从未声明过的字段固化进副本。
   */
  writePresetMeta(dir, {
    name: clean,
    description: sourceMeta.description ? sourceMeta.description : undefined,
    order,
  })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  return readAgent(paths, id)
}

/**
 * 把一个伙伴目录从**旧位置**（`<dshHome>/.agent-presets/<id>/`）搬到新位置
 * （`<dshHome>/companion/companions/<id>/`）。
 *
 * 为什么要搬：rc2 起官方完全不再读 `.agent-presets/`，继续放那里会让"伙伴"
 * 看起来像官方预设、实际官方不看，排查时极易误判。搬走后该目录是纯粹的本插件数据。
 *
 * **只移动，不改内容**：六个 MD、memory/、changelog/、preset.yml 原样过去；
 * 旧格式遗留的 `agent.cordis.yml` 也一并保留（回滚依据，且现在已无任何作用）。
 *
 * @returns {{migrated: boolean, reason?: string, target?: string}}
 */
export function migrateAgent(paths, id) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const from = join(paths.legacyPresetsRoot, id)
  const to = join(paths.companionsRoot, id)
  if (existsSync(to)) return { migrated: false, reason: '新位置已存在同名伙伴', target: to }
  if (!existsSync(from)) return { migrated: false, reason: '旧位置没有这个伙伴' }
  mkdirSync(dirname(to), { recursive: true })
  try {
    renameSync(from, to)
  } catch {
    // 跨卷时 rename 会失败，退回递归拷贝后删源，保证迁移仍能完成。
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
  return { migrated: true, target: to }
}

/**
 * 列出还留在旧位置、可以迁移过来的伙伴 id。
 *
 * 判据是"目录里有 settings.json / preset.yml 或六个 MD 之一"——只看目录名
 * 会把用户在 `.agent-presets/` 下随手建的无关目录也算进来。
 * 两种元数据文件名都认：迁移前的旧目录只有 preset.yml。
 */
export function listLegacyAgents(paths) {
  if (!existsSync(paths.legacyPresetsRoot)) return []
  return readdirSync(paths.legacyPresetsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => PRESET_ID.test(id))
    .filter((id) => !existsSync(join(paths.companionsRoot, id)))
    .filter((id) => {
      const dir = join(paths.legacyPresetsRoot, id)
      return existsSync(join(dir, META_FILE))
        || existsSync(join(dir, LEGACY_META_FILE))
        || PRESET_FILES.some((item) => existsSync(join(dir, item.file)))
    })
}

/**
 * 删除 = 移动到备份目录（不真删）。
 *
 * 同时清掉所有指向该伙伴的会话绑定：伙伴目录都没了，留着绑定只会在重开
 * 那些会话时解析到一个不存在的目录 —— 静默不注入，且记录永不消失。
 * 这正是绑定表**不再随 agent/disposed 清理**之后必须补上的那个清理点。
 */
export async function archiveAgent(paths, id, now = new Date()) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const dir = join(paths.companionsRoot, id)
  if (!existsSync(dir)) throw new Error(`伙伴不存在：${id}`)
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  const target = join(paths.backupRoot, `${id}-${stamp}`)
  mkdirSync(paths.backupRoot, { recursive: true })
  try {
    renameSync(dir, target)
  } catch {
    // 跨卷时 rename 会失败（与 migrateAgent 同一处理）：退回递归拷贝后删源。
    cpSync(dir, target, { recursive: true })
    rmSync(dir, { recursive: true, force: true })
  }
  let bindingsRemoved = 0
  try { bindingsRemoved = (await deleteBindingsFor(paths, id)).removed } catch { /* 绑定清理失败不影响归档 */ }
  return { archived: target, bindingsRemoved }
}

/** 日记列表（日期倒序）。id 与日期都做校验，避免路径穿越。 */
export function listJournal(paths, id) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  const dir = join(paths.companionsRoot, id, 'memory')
  if (!existsSync(dir)) return []
  const rows = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md') || !DATE_KEY.test(name.slice(0, -3))) continue
    const full = join(dir, name)
    const text = readText(full)
    const first = text.split('\n').find((line) => line.trim() && !line.startsWith('#')) ?? ''
    rows.push({ date: name.slice(0, -3), size: statSync(full).size, preview: first.trim().slice(0, 60) })
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/** 读某天日记全文。 */
export function readJournal(paths, id, date) {
  if (!PRESET_ID.test(id)) throw new Error(`非法 id：${id}`)
  if (!DATE_KEY.test(date)) throw new Error(`非法日期：${date}`)
  return readText(join(paths.companionsRoot, id, 'memory', `${date}.md`))
}

/* ────────────────────────────── HTTP ────────────────────────────── */

/** 请求体上限（字节）：超过即拒绝，避免无上限累积导致内存膨胀。 */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * 读请求体，超过上限抛 413。
 *
 * **超限时不能立刻 `req.destroy()`**：那会把 socket 一起拆掉，等上层 catch 里
 * 写响应时连接已经死了——客户端拿到的是 `UND_ERR_SOCKET`（「网络错误，未知原因」），
 * 而不是 413。用户体感从「请求体超过上限」退化成看不出原因的连接失败。
 *
 * 正确做法：标记超限、**停止累积**（丢掉后续 chunk 释放引用），但仍把流读完，
 * 让上层能正常写回 413；响应发完由 Node 自己收尾。
 */
function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let overflowed = false
    req.on('data', (chunk) => {
      if (overflowed) return // 已判超限：不再累积，仅把剩余数据读掉
      size += chunk.length
      if (size > limit) {
        overflowed = true
        chunks.length = 0
        reject(new HttpError(413, `请求体超过上限 ${limit} 字节`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      // 超限后我们已 reject，此后的 socket 错误不该再改变结果
      if (!overflowed) reject(error)
    })
  })
}

/** 读 JSON 请求体。体积超限（HttpError）要原样抛出，不能被当成「非法 JSON」吞掉。 */
async function readJson(req) {
  let raw
  try {
    raw = await readBody(req)
  } catch (error) {
    if (error instanceof HttpError) throw error
    return null
  }
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null
  }
}

/** 把领域函数抛出的错误映射成合适的 HTTP 状态：业务校验错误不该报成 500。 */
export function statusOfError(error) {
  if (error instanceof HttpError) return error.status
  const message = error instanceof Error ? error.message : String(error)
  if (/非法 id|不允许写|请输入昵称|昵称不能为空|请求体|过长/.test(message)) return 400
  if (/伙伴不存在/.test(message)) return 404
  return 500
}

/**
 * 判断一个写请求是不是**同源页面**发来的。
 *
 * ## 为什么必须自己校验
 *
 * 官方没有全局来源校验：`dsh-host-webserver` 的 `handle()` 只做路由分发
 * （`lib/index.js` 的 `Service.init`，唯一中间件是可选 gzip）。官方确实有
 * 一道 fence（`dsh-client-connection` 的 `isTrustedApiRequest`：校验 host 回环 +
 * `sec-fetch-site !== 'cross-site'` + Origin 同源，不给过就 403），但它只挂在
 * **`/api` 那一条 channel** 上。本插件注册的 `/companion` 是独立 route，
 * 完全不经过它——这里是唯一防线。
 *
 * 不设防的后果不是「读数据」，而是**在用户的预设目录里凭空造伙伴**：
 * `POST /api/agents` 配 `content-type: text/plain` 属于 CORS「简单请求」，
 * 不需要预检，任意网页都能打通；写进去的昵称会进 `IDENTITY.md` / `USER.md`。
 * （`PUT` / `DELETE` 因为要预检、而我们对 `OPTIONS` 回 404 无 ACAO，
 * 是被**偶然**挡住的，不能当成设计。）实测确认过这条链路可达。
 *
 * ## 判据（照抄官方 `/api` fence 的口径）
 *
 * - `sec-fetch-site: cross-site` → 拒。这是浏览器给出的、页面脚本无法伪造的信号。
 * - 带 `origin` 头时：必须是可解析的、与 `host` 同源的值；
 *   `origin: null`（沙箱 iframe / data: 页面）一律拒。
 * - **两个头都拿不到**（非浏览器客户端，如 curl）→ 放行：
 *   我们防的是「用户浏览器里的恶意页面」，不是本机命令行的使用者。
 */
export function isSameOriginRequest(req) {
  const headers = req?.headers ?? {}
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false

  const origin = headers.origin
  // 没有 Origin 头：非浏览器客户端（或同源的旧式请求），交给上层
  if (typeof origin !== 'string' || origin === '') return true

  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  // `null` 是不可信来源（沙箱 iframe / data: URL），不能当成「没有 Origin」
  if (origin === 'null') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 读方法不写盘，不参与来源校验。 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** 取会话事件（走官方的公开读取 API，不读私有字段）。 */
function readSessionEvents(session) {
  try {
    return sessionEvents(session) ?? []
  } catch {
    return []
  }
}

/** 把任意异常压成一行可读文本（打日志用）。 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读一个会话当前绑定的伙伴。
 *
 * 两读法并存，顺序有讲究：
 * 1. **绑定表**（`bindings.json`）—— 现在的正道，按 sessionId 索引；
 * 2. **事件流兜底** —— 只为兼容历史上已经写进会话日志的旧绑定事件。
 *
 * 为什么还留兜底：那些旧事件我们已无法再写（见 companion.mjs 的说明），
 * 但它们确实存在于用户磁盘上的历史会话里，直接不认会让"老会话的伙伴"丢失。
 *
 * @returns 伙伴 id，或 null（从未绑定 / 显式选了「无伙伴」）。
 */
function companionBindingOf(paths, session) {
  const fromTable = readBindings(paths)[session?.id]
  if (fromTable !== undefined) return fromTable ? normalizeCompanion(fromTable) : null
  // 兜底：事件流里出现过绑定事件则以最后一次为准
  const events = readSessionEvents(session)
  return events.some((event) => event?.type === 'companion/selected')
    ? companionFromEvents(events)
    : null
}

/**
 * 会话的**当前官方预设**。
 *
 * 读法（两级，缺一不可）：
 * 1. 事件流里最后一条 `agent-preset/selected`（官方 select 会在 blank 窗口内
 *    append 这条事件，见 `dsh-agent-preset-registry/lib/index.js:761`）；
 * 2. 没有这条事件 → 回落到 **创建记录里的 `header.agentPreset`**。
 *
 * ⚠️ 第 2 级不能省。会话创建时就带着预设（实测会话文件第 1 行：
 * `{"type":"session",…,"agentPreset":"standard-gitbash"}`），若只看事件流，
 * 「建好就选伙伴、从没切过档」的会话会被判成"识别不出预设"而拒绝注入。
 * 队友插件 dsh-tavern-v2 在这里踩过坑并写进了注释：那行创建记录**不含**
 * `agent-preset/selected` 或 `header` 字样，靠字样匹配会一路漏判。
 *
 * 为什么不读投影 store：host 侧的 session 对象不直接暴露投影当前值，
 * 而事件流本身就是这个投影的 fold 源（`agentPresetProjectionDefinition.apply`），
 * 从事件流读与官方读法等价。
 *
 * @returns 'companion-mode' | 其他预设 id | undefined（两级都拿不到）。
 */
function sessionPresetOf(session) {
  let current
  for (const event of readSessionEvents(session)) {
    if (event?.type === 'agent-preset/selected') current = event?.data?.agentPreset
  }
  if (typeof current === 'string' && current !== '') return current
  // 回落到创建记录：会话对象上没有 header 时返回 undefined（旧版本 / 假 ctx）。
  const header = session?.header
  return typeof header?.agentPreset === 'string' && header.agentPreset !== ''
    ? header.agentPreset
    : undefined
}

/**
 * 伙伴绑定是否还允许修改。
 *
 * 规则（用户要求）：**开对话前可选，开对话后锁定**。
 *
 * 判据取官方 `SessionSnapshot` 的同名语义：
 * - `blank === false`：会话已经开始过
 * - `promptAttempted === true`：已经提交过第一条消息
 *
 * 任一成立即视为"已开始"。会话没有这些字段时（老版本 / 极早期）保守地
 * **允许**修改 —— 宁可让用户在极少数情况下多改一次，也不要让所有人都改不了。
 */
function canRebind(session) {
  if (!session) return false
  if (session.blank === false) return false
  if (session.promptAttempted === true) return false
  return true
}

/** 注册 `/companion` 前缀路由。 */
export function registerRoutes(ctx, home) {
  const paths = resolvePaths(home)

  /*
   * 会话索引：sessionId -> Session，供伙伴下拉写入绑定。
   *
   * 由 `agent/created` 维护、`agent/disposed` 清理。这样下拉只需要传一个
   * sessionId，Host 侧就能拿到真正的 Session 对象去追加事件 —— 客户端
   * 不该、也不能直接写会话日志。
   */
  const sessionIndex = new Map()
  /*
   * 每个会话的提示词注入句柄：sessionId -> injectCompanionPrompt 的返回值。
   *
   * 注册发生在**该会话自己的 scope** 里（`agent/created` 监听器的 `this`），
   * 所以每个会话有一套独立的 section/变量，互不干扰 —— 这正是"官方预设 +
   * 伙伴共存"的关键：没绑伙伴的会话根本不注册，官方提示词原样生效。
   */
  const injections = new Map()
  /*
   * sessionId -> **工具收窄的 disposer**（`tools.restrict()` 的返回值）。
   *
   * 为什么必须自己存：官方 restriction 是**只增不减 + 交集**语义
   * （`dsh-tools/lib/index.js:2641-2644` 的 `admits()` 要求每一条都放行）。
   * 所以同一个会话**再次** restrict 不会替换旧的，而是与它取交集：
   *
   * - 换伙伴（allow=[read] → allow=[read,write]）：交集仍是 [read]，
   *   新伙伴的 write 永远拿不到；
   * - 置空「无伙伴」：旧收窄继续生效，置空了还是被限制；
   * - 切回官方 standard：官方模式本该有全套工具，却仍被我们的 allow 挡着。
   *
   * 撤销入口只有 `restrict()` 返回的那个 disposer。丢掉它 = 把会话永久钉在
   * 第一次下发的收窄上。所以这里按会话存住，换伙伴/置空/切走时**先撤再装**。
   */
  const restrictions = new Map()
  /**
   * 撤掉某会话已下发的工具收窄。
   * @param {string} sessionId - 会话 id。
   */
  const liftRestriction = (sessionId) => {
    const dispose = restrictions.get(sessionId)
    restrictions.delete(sessionId)
    if (typeof dispose !== 'function') return
    try {
      dispose()
    } catch {
      /* 已撤或 scope 已销毁 */
    }
  }
  /**
   * 按伙伴重装收窄：**先撤旧的，再按新伙伴决定装不装**。
   *
   * 只有"先撤"才能保证语义是**替换**而不是交集 —— 见 `restrictions` 的说明。
   * @param {string} sessionId - 会话 id。
   * @param {string} dir - 伙伴目录；空串表示置空（只撤不装）。
   */
  const applyRestrictionFor = (sessionId, dir) => {
    liftRestriction(sessionId)
    if (!dir) return
    const agentCtx = agentCtxOf(sessionId)
    if (!agentCtx) return
    const result = restrictCompanionTools(agentCtx, readPresetMeta(dir).tools, ctx.logger)
    if (result.applied && typeof result.dispose === 'function') {
      restrictions.set(sessionId, result.dispose)
    }
  }
  /*
   * sessionId -> **该会话 scope 的 ctx**。
   *
   * 必须在这里存下来：`agent/created` 监听器的 `this` 就是 agent scope，
   * 但监听器只跑一次；用户之后在"新建对话"页选伙伴时（走 /api/companion）
   * 还需要这个 ctx 才能把 section 注册进同一个 scope。
   */
  const agentCtxBySession = new Map()
  const agentCtxOf = (sessionId) => agentCtxBySession.get(sessionId)

  ctx.on?.('agent/created', function (payload) {
    const agent = payload?.agent
    const session = agent?.session
    if (!session?.id) return
    sessionIndex.set(session.id, session)
    /*
     * ⚠️ 这里必须存 **`agent.ctx`**，不能存监听器的 `this`。
     *
     * 官方把 `agent/created` 的 `this` 标为 `Scoped<Agent>`
     * （`dsh-agent/lib/types/runtime-types.d.ts:227`），而 `Scoped<T>` 的定义是
     * `object & { readonly [ScopedBrand]: T }`（`dsh-scope/lib/types/index.d.ts:18`）
     * —— 它只是个**作用域路由标记**，不是 Context。
     *
     * 运行时它由 `scopeTarget(agent, agent)` 构造（`dsh-agent/lib/index.js:231`）。
     * 实测该对象**只有 `Symbol(cordis.filter)` 一个成员**：
     *   carrier.systemPrompt === undefined，carrier.effect === undefined
     * 于是 `this.systemPrompt.section(...)` 必然抛 TypeError，被下面的 catch
     * 吞成一条 warn —— 表现为"伙伴选好了、绑定也写进会话日志了，
     * 但提示词里一个字都没有"。
     *
     * 真正的 per-agent scope 是 `agent.ctx`（见 `dsh-agent-loop/lib/index.js:778-779`
     * 的 `this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx`）；
     * 官方全部示例（file-reference-local / tool-agent-team 等）用的都是它。
     */
    agentCtxBySession.set(session.id, agent?.ctx)

    /*
     * 建会话时若已带绑定（例如恢复旧会话），就直接装上；
     * 否则先不注册 —— 用户可能在"新建对话"页选完伙伴才发第一条消息，
     * 那时由 /api/companion 补上。
     *
     * 读法：先查绑定表，再兜底折叠事件流（兼容历史上写进日志的旧绑定）。
     *
     * ⚠️ 装注入前必须核对**当前官方预设**：伙伴绑定只对「伙伴模式」会话有意义。
     * 用户可以在 blank 窗口内把会话从伙伴模式切到标准模式（官方 select 允许），
     * 切换会 append `agent-preset/selected` —— 若不看这条事件，恢复旧会话时
     * 绑定表里的残留会让"标准模式的会话"装上伙伴人设：官方提示词 + 莉莉人设
     * 同时在跑，工具集却是标准模式的全套（正是实测出的事故）。
     */
    /*
     * 装注入前先判两件事，顺序不能反：
     *
     * ① **是不是伙伴模式**（只看预设）——伙伴绑定只对「伙伴模式」会话有意义。
     *    用户可以在 blank 窗口内把会话从伙伴模式切到标准模式（官方 select 允许），
     *    切换会 append `agent-preset/selected` —— 若不看这条事件，恢复旧会话时
     *    绑定表里的残留会让"标准模式的会话"装上伙伴人设：官方提示词 + 莉莉人设
     *    同时在跑，工具集却是标准模式的全套（正是实测出的事故）。
     *
     *    **识别不出就当作不是**：事件流里既没有 `agent-preset/selected`、
     *    header 里也没有 `agentPreset` 时，我们无法确认这是伙伴会话，
     *    宁可少注入也不能错注入 —— 错注入会把官方提示词整个顶掉。
     *    这条判据只回答"能不能注入"，**不回答"是哪个伙伴"**。
     *
     * ② **是哪个伙伴**（binding 优先，事件流兜底）——见 companionBindingOf。
     */
    const presetNow = sessionPresetOf(session)
    if (presetNow !== COMPANION_PRESET_ID) {
      // 明确切到了别的预设：清掉残留绑定，保持与预设一致。
      // 识别不出预设时同样走这里，但**不动绑定表**（拿不准就不破坏数据）。
      if (presetNow !== undefined) {
        // 写绑定是异步的（共用按路径队列）：这里不 await（在同步监听器里），
        // 但必须挂 catch —— 否则一次失败会变成 unhandledRejection。
        deleteBinding(paths, session.id).catch(() => { /* 清不掉也不装注入 */ })
      }
      return
    }
    const bound = companionBindingOf(paths, session)
    if (!bound) return
    const dir = join(paths.companionsRoot, bound)
    if (!existsSync(dir)) return
    const agentCtx = agent?.ctx
    if (!agentCtx) {
      ctx.logger?.warn?.(`[companion] 会话 ${session.id} 取不到 agent.ctx，提示词注入跳过`)
      return
    }
    try {
      // 在 `agent.ctx` 里注册即 per-session。
      injections.set(session.id, injectCompanionPrompt(agentCtx, dir, () => readSettings(paths)))
    } catch (error) {
      ctx.logger?.warn?.(`[companion] 会话 ${session.id} 的提示词注入注册失败：${describeError(error)}`)
    }

    /*
     * 按伙伴收窄工具清单 —— 与上面的提示词注入**同一个落点、同一个 ctx**。
     *
     * 为什么必须在这里：`tools.restrict()` 官方要求 agent scope
     * （`dsh-tools/lib/index.js:2897`，"a context-global restriction would mask
     * every agent"）。preset 行插件的 ctx 是 preset scope，表达不了"这是哪个伙伴"。
     *
     * 数据源是**当前伙伴自己的 settings.json**，所以每个伙伴可以各不相同：
     * 纯聊天的那个写 `allow`，别的伙伴不写就照常拿到全套工具。
     *
     * 失败静默降级（只 warn）：收窄是优化，不该让会话起不来。
     */
    try {
      // 先撤旧的再装（restriction 是交集语义，不撤就会与旧伙伴取交集）
      applyRestrictionFor(session.id, dir)
    } catch (error) {
      ctx.logger?.warn?.(`[companion] 会话 ${session.id} 的工具收窄注册失败：${describeError(error)}`)
    }
  })

  ctx.on?.('agent/disposed', (payload) => {
    const session = payload?.agent?.session
    if (!session?.id) return
    sessionIndex.delete(session.id)
    agentCtxBySession.delete(session.id)
    /*
     * restriction 随 agent scope 销毁会自动失效（它挂在那个 layer 上），
     * 这里清的是我们自己的 Map 引用 —— 不清会随用过的会话数无限增长。
     */
    restrictions.delete(session.id)
    /*
     * ⚠️ 这里**不再**删绑定表里的记录。
     *
     * `agent/disposed` 的含义是「这个活着的 agent 对象被注销了」
     * （官方定义：注册它的 fiber 被卸载时触发，见 dsh-agent/lib/index.js:472-486），
     * 它**不等于**「会话没用了」——进程重启、归档、临时关闭窗口都会触发。
     *
     * 早先在这里 deleteBinding，后果是：重开一个历史会话时绑定已经不在，
     * 于是伙伴人设静默丢失（回落官方提示词，没有任何提示）——而恢复的唯一
     * 正式来源就是这张表，删掉它等于把恢复兜底作废（评审 W3）。
     *
     * 所以绑定改为**按会话语义**存活：
     * - 会话明确切到别的预设（`agent-preset/selected`）→ 删（那里删，见下方监听）；
     * - 用户在设置页删除伙伴 → 删（见 deleteAgent 的清理）；
     * - 其余情况保留，重开会话时按 binding 装回人设。
     *
     * 代价是文件会随「用过的会话数」增长。这个代价是明知的：一行只是一个
     * sessionId + 伙伴 id，且清理点覆盖了真正代表"这段关系结束了"的两种事件。
     */
    // 会话销毁时撤掉该会话的 section/变量，避免泄漏到别的会话。
    try { injections.get(session.id)?.dispose() } catch { /* 已撤 */ }
    injections.delete(session.id)
  })

  /*
   * 官方预设切换：`agent-preset/selected` 由 agent-preset-registry 广播
   * （`dsh-agent-preset-registry/lib/index.js:489`，签名 `(sessionId, presetId)`）。
   *
   * 为什么必须听它：伙伴人设注入与官方预设是**两层独立的东西** ——
   * 预设决定工具集，伙伴决定 persona section。用户在 blank 窗口内把会话从
   * 「伙伴模式」切到「标准模式」时，官方只换工具集，不会通知我们撤人设 ——
   * 不处理就成了"标准模式的全套工具 + 莉莉的人设"（实测事故）。
   *
   * - 切**走**（→ 非 companion-mode）：撤该会话注入 + 删绑定。绑定不删的话，
   *   会话重开时 agent/created 又会按残留绑定装回人设。
   * - 切**回**（→ companion-mode）：恢复绑定表里可能存在的记录（切走时刚删了，
   *   这里通常无事可做；从其他路径恢复的会话则能装回）。
   */
  ctx.on?.('agent-preset/selected', (sessionId, presetId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (presetId === COMPANION_PRESET_ID) {
      // 切回伙伴模式：若绑定表还有记录（例如事件流兜底来的旧绑定），装回注入。
      const bound = readBindings(paths)[sessionId]
      const dir = bound ? join(paths.companionsRoot, normalizeCompanion(bound)) : ''
      const agentCtx = agentCtxOf(sessionId)
      /*
       * 收窄与注入**各自判各自的前置条件**，不共用同一个 early return。
       *
       * 早先这里是 `if (... || injections.has(sessionId)) return`，一个守卫管两件事。
       * 而 `injections` 记的是**提示词注入**有没有装过：会话在 `agent/created`
       * 时若已带绑定（恢复旧会话、或"先绑后再切"的常见次序），注入已存在——
       * 于是整段被跳过，**收窄永远装不上**（2026-09-28 实测事故：09-27 建的历史
       * 会话当天切到伙伴模式，人设装上了、34 个工具原样可见含 write/edit/pwsh）。
       *
       * 所以拆开：注入按 `injections` 幂等，收窄**每次都重装**——`tools.restrict`
       * 返回的是 disposer，重复调用会叠加 restriction；但同一会话对同一伙伴重复
       * 装是无害的幂等（filter 完全相同），而漏装的代价是整个功能不生效。
       * 宁可重复装，不可漏装。
       */
      if (dir && existsSync(dir) && agentCtx) {
        if (!injections.has(sessionId)) {
          try {
            injections.set(sessionId, injectCompanionPrompt(agentCtx, dir, () => readSettings(paths)))
          } catch (error) {
            ctx.logger?.warn?.(`[companion] 会话 ${sessionId} 切回伙伴模式装回注入失败：${describeError(error)}`)
          }
        }
        /*
         * 工具收窄：**第二条注册路径**（第一条是 `agent/created`），漏了它会静默失效。
         * 上面那段"为什么必须听它"的注释早就点明两层是独立的
         * （"预设决定工具集，伙伴决定 persona section"）—— 收窄就是"工具那一层"。
         */
        try {
          applyRestrictionFor(sessionId, dir)
        } catch (error) {
          ctx.logger?.warn?.(`[companion] 会话 ${sessionId} 切回伙伴模式装回工具收窄失败：${describeError(error)}`)
        }
      }
      return
    }
    // 切走到其他预设：撤人设 + 清绑定，让会话回到"纯官方"状态。
    try { injections.get(sessionId)?.dispose() } catch { /* 已撤 */ }
    injections.delete(sessionId)
    /*
     * 工具收窄也要撤 —— 这是本次审查发现的缺陷之一。
     *
     * 不撤的后果：切回官方 standard 后，官方模式本该拿到全套工具，
     * 却仍被上一个伙伴的 allow 名单挡着（restriction 挂在 agent scope 的
     * layer 上，不会因为换了预设就消失）。
     */
    liftRestriction(sessionId)
    deleteBinding(paths, sessionId).catch(() => { /* 清理失败不影响切换 */ })
  })

  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = statusOfError(error)
      // 未知异常才是 500：这时才值得记一条 warn，业务错误不必刷日志
      if (status >= 500) ctx.logger?.warn?.(`[companion] 请求处理失败：${message}`)
      sendJson(res, status, { error: message })
    }
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: guard(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const rest = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const method = req.method ?? 'GET'

      /*
       * 来源校验放在最前：写请求一律要过，且要早于读体——
       * 否则跨站请求还能靠超大 body 逼我们读满再拒。
       */
      if (WRITE_METHODS.has(method) && !isSameOriginRequest(req)) {
        ctx.logger?.warn?.(`[companion] 拒绝跨站写请求：${method} ${rest}`)
        return sendJson(res, 403, { error: '拒绝来自其他站点的写请求' })
      }

      if (rest === '/api/agents' && method === 'GET') return sendJson(res, 200, { agents: listAgents(paths) })
      if (rest === '/api/agents' && method === 'POST') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return sendJson(res, 201, { agent: createAgent(paths, body) })
      }
      if (rest === '/api/settings' && method === 'GET') return sendJson(res, 200, { settings: readSettings(paths) })
      if (rest === '/api/settings' && method === 'PUT') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return sendJson(res, 200, { settings: writeSettings(paths, body) })
      }

      /*
       * 伙伴下拉用：列出可用伙伴 + 读/写当前会话的绑定。
       *
       * 绑定住在插件自己的 `bindings.json`（按 sessionId 索引），
       * **不再写进会话事件流** —— 原因见 companion.mjs 的顶部说明：
       * 官方 v4 门禁会拒绝解读带未知事件类型的日志，那会让会话直接打不开。
       */
      if (rest === '/api/companions' && method === 'GET') {
        /*
         * `?session=<id>` 时顺带回当前绑定。
         *
         * 下拉必须知道"这个会话现在用哪个伙伴"才能显示正确的那一项；
         * 会话不在索引里（例如已关闭）就回 null —— 不是错误，
         * 列表本身仍然有效，用户可以看但不能改。
         */
        const wanted = url.searchParams.get('session')
        const live = wanted ? sessionIndex.get(wanted) : undefined
        return sendJson(res, 200, {
          companions: listAgents(paths).map((item) => ({ id: item.id, name: item.name, description: item.description })),
          current: live ? companionBindingOf(paths, live) : readBindings(paths)[wanted] ?? null,
        })
      }
      if (rest === '/api/companion' && method === 'PUT') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        const wanted = normalizeCompanion(body.companion)
        // 选了具体伙伴时必须真实存在，否则会变成"静默不注入"——那太难排查。
        if (wanted && !existsSync(join(paths.companionsRoot, wanted))) {
          return sendJson(res, 404, { error: `伙伴不存在：${wanted}` })
        }
        const sessionId = typeof body.session === 'string' ? body.session : ''
        const session = sessionIndex.get(sessionId)
        if (!session) return sendJson(res, 409, { error: '该会话已不在运行，无法修改伙伴绑定' })
        if (!canRebind(session)) {
          return sendJson(res, 409, { error: '对话已开始，伙伴不可更改（新开一个对话即可重新选择）' })
        }
        // 必须 await：绑定落盘失败要如实报给用户（5xx），不能让界面显示"选上了"。
        await recordCompanionSelection(paths, sessionId, wanted)

        /*
         * 立刻把注入换成新绑定 —— 用户选完伙伴就要生效，不能等到下次重启。
         *
         * 三个分支：
         * - 原来没注入、现在选了伙伴 -> 新建注入
         * - 原来有注入、现在换/取消 -> refresh（空串即撤掉全部 section）
         * - 选了「无伙伴」且原本就没有 -> 什么都不做（保持官方提示词）
         *
         * 注意"取消伙伴"必须真的**撤掉 section**，而不是让它渲染成空串：
         * 空文本的 complete 段会把系统提示词清成 ""（见 core.js 的说明）。
         */
        try {
          const dir = wanted ? join(paths.companionsRoot, wanted) : ''
          const existing = injections.get(sessionId)
          if (existing) {
            existing.refresh(dir)
            if (!dir) {
              existing.dispose()
              injections.delete(sessionId)
            }
          } else if (dir) {
            const agentCtx = agentCtxOf(sessionId)
            if (agentCtx) {
              injections.set(sessionId, injectCompanionPrompt(agentCtx, dir, () => readSettings(paths)))
            } else {
              ctx.logger?.warn?.(`[companion] 会话 ${sessionId} 的 agent scope 不可用，注入将在下次装配时缺省`)
            }
          }
        } catch (error) {
          ctx.logger?.warn?.(`[companion] 切换伙伴注入失败：${describeError(error)}`)
        }

        /*
         * 工具收窄也要在这里装 —— 这是**第三条、也是最关键的一条**注册路径。
         *
         * ## 为什么前两条不够（2026-09-28 实测事故）
         *
         * 真实交互次序是：**新建会话 → 切预设 → 选伙伴**。而：
         *
         * - `agent/created`（会话创建 17:06:11）时绑定表**还是空的** → return；
         * - `agent-preset/selected`（切预设 17:06:13）时绑定**仍然空** → dir 为空 → 跳过；
         * - 用户选伙伴写绑定是 **17:06:14**——**在两条事件之后**。
         *
         * 绑定写入**本身不触发任何事件**（它只是写 bindings.json），
         * 所以前两条路径全都抢在绑定之前，收窄永远装不上。
         * 表现：35 个工具原样可见，含 write / edit / pwsh。
         *
         * 这里才是正确的时机：用户明确表达"这个会话用这个伙伴"的那一刻。
         * 上面那段注入代码早就在这里 refresh 了，收窄当时没跟着做，属于遗漏。
         *
         * 选「无伙伴」时不装也不撤：`restrict` 返回的 disposer 我们没有留着，
         * 撤不掉已下发的 restriction。这与"绑定住 bindings.json、不随会话销毁
         * 清除"的既有取舍一致（该会话下次重建时自然不带收窄）。
         */
        try {
          /*
           * wanted 为空 = 置空「无伙伴」：**只撤不装**。
           * 这里必须真的撤掉，否则置空后旧伙伴的 allow 还生效 —— 用户以为
           * 放开了，实际仍被限制在旧名单里。
           */
          applyRestrictionFor(sessionId, wanted ? join(paths.companionsRoot, wanted) : '')
          if (wanted) {
            const agentCtx = agentCtxOf(sessionId)
            if (!agentCtx) {
              ctx.logger?.warn?.(`[companion] 会话 ${sessionId} 的 agent scope 不可用，工具收窄将在下次装配时缺省`)
            }
          }
        } catch (error) {
          ctx.logger?.warn?.(`[companion] 切换伙伴时装工具收窄失败：${describeError(error)}`)
        }
        return sendJson(res, 200, { current: wanted })
      }

      const agentMatch = /^\/api\/agents\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(rest)
      if (!agentMatch) return sendJson(res, 404, { error: 'not found' })
      const id = agentMatch[1]
      const sub = agentMatch[2] ?? ''

      if (sub === '' && method === 'GET') return sendJson(res, 200, { agent: readAgent(paths, id) })
      if (sub === '' && method === 'DELETE') return sendJson(res, 200, await archiveAgent(paths, id))
      if (sub === '/copy' && method === 'POST') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return sendJson(res, 201, { agent: copyAgent(paths, id, body) })
      }
      if (sub === '/meta' && method === 'PUT') {
        const body = await readJson(req)
        if (!body) return sendJson(res, 400, { error: '请求体不是合法 JSON' })
        const dir = join(paths.companionsRoot, id)
        if (!existsSync(dir)) return sendJson(res, 404, { error: `伙伴不存在：${id}` })
        const current = readPresetMeta(dir)
        // 昵称不允许清空：静默把 name 写没会让元数据丢字段，
        // 这里显式拒绝，把决定权交回用户。
        if (body.name !== undefined && String(body.name).trim() === '') {
          return sendJson(res, 400, { error: '昵称不能为空' })
        }
        writePresetMeta(dir, {
          name: assertLength(String(body.name !== undefined ? String(body.name).trim() : current.name), MAX_NAME_CHARS, '昵称'),
          /*
           * description 只有「用户显式提交了这个键」才动它：
           * 提交空串 = 清空签名（写出 `description: ""`，
           * 与「不提交该键」= 保持原样，是两件事）。
           */
          description: assertLength(
            body.description !== undefined ? String(body.description) : current.description,
            MAX_DESCRIPTION_CHARS,
            '个性签名',
          ),
          order: current.order,
        })
        return sendJson(res, 200, { agent: readAgent(paths, id) })
      }
      if (sub === '/file' && method === 'PUT') {
        const body = await readJson(req)
        if (!body || typeof body.file !== 'string') return sendJson(res, 400, { error: '需要 { file, content }' })
        // baseVersion 可选：带上则做乐观并发校验（后台自动记忆可能已改过该文件）
        const result = await writeAgentFile(paths, id, body.file, body.content, { baseVersion: body.baseVersion })
        return sendJson(res, 200, result)
      }
      if (sub === '/journal' && method === 'GET') return sendJson(res, 200, { journal: listJournal(paths, id) })
      const journalMatch = /^\/journal\/(\d{4}-\d{2}-\d{2})$/.exec(sub)
      if (journalMatch && method === 'GET') {
        return sendJson(res, 200, { date: journalMatch[1], text: readJournal(paths, id, journalMatch[1]) })
      }
      return sendJson(res, 404, { error: 'not found' })
    }),
  })
}

export const name = 'companion-host'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  registerRoutes(ctx, config.dshHome)

  /*
   * 注册「伙伴模式」预设（声明式，rc2 官方通道）。
   *
   * 为什么必须走这里：rc2 起官方不再读 `.agent-presets/<id>/agent.cordis.yml`，
   * 伙伴的轻量工具清单此前从未生效——实测伙伴会话跑的是 standard-gitbash 的
   * 51 个工具（含 workflow / subagent / plan mode / goal）。唯一官方通道是
   * `ctx.agentPresets.register(...)`（活样本 dsh-gitbash-shell/src/index.js:2031）。
   *
   * 用 `ctx.inject(['agentPresets'], ...)` 而不是直接 `ctx.agentPresets`：
   * 该服务并非处处可用（headless profile 就没有），缺了它顶多少一个预设，
   * 不该把整个 host 半（路由/注入）一起带崩。
   */
  try {
    ctx.inject(['agentPresets'], (scope) => {
      const registry = scope?.agentPresets
      if (!registry || typeof registry.register !== 'function') return
      const unregister = registry.register({
        ...companionPresetMeta(),
        plugins: companionPresetPlugins(),
      })
      scope.effect?.(() => unregister, 'companion: companion preset registration')
    })
  } catch (error) {
    ctx.logger?.warn?.(`[companion] 伙伴模式预设注册失败：${describeError(error)}`)
  }

  /*
   * 孤儿绑定清理（GC）：绑定不再随 agent/disposed 清除（那会让重开会话恢复不了
   * 人设），所以会在用户彻底删掉会话后留下残留。这里在启动时清理一次。
   *
   * 三条纪律：
   * - **异步、不阻塞**：`listSessions` 可能要读持久化后端，绝不能挡在 apply 里；
   * - **服务可能不存在**（headless profile）：取不到就什么都不做，不是错误；
   * - **失败静默降级**：清理只是维护性工作，出错绝不打扰用户（只记 info/warn）。
   *
   * 真正防误删与防并发覆盖的逻辑在 binding-gc.mjs 里（判据用 persisted，
   * 写回在按路径队列内重读最新表）。
   */
  try {
    ctx.inject(['sessionQuery'], (scope) => {
      const paths = resolvePaths(config.dshHome)
      void collectOrphanBindings(paths, scope?.sessionQuery)
        .then((removed) => {
          if (removed.length > 0) {
            ctx.logger?.info?.(`[companion] 已清理 ${removed.length} 条孤儿会话绑定`)
          }
        })
        .catch((error) => {
          ctx.logger?.warn?.(`[companion] 孤儿绑定清理失败（不影响其余功能）：${describeError(error)}`)
        })
    })
  } catch (error) {
    ctx.logger?.warn?.(`[companion] 孤儿绑定清理未执行：${describeError(error)}`)
  }
}
