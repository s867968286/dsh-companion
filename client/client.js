/**
 * dsh-companion 的 Client 半：在官方设置页里注册一个「伙伴设置」页面。
 *
 * - 只用一个官方 slot：`settings.section`（一个注册 = 一个设置页，导航行由官方渲染）；
 * - 不引任何 UI 组件库：React.createElement + 原生 input/textarea/button；
 * - 数据全部走 Host 半的 `/companion/api/*`（同源 fetch）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-companion',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // 不 require 任何官方 UI 包：`@deepseek-ai/dsh-client-ui-primitives` 在当前 DSH
    // 版本已不存在，顶层解构会抛错，导致 factory 失败 → apply 从不执行 → 整页裸样式。
    // 组件与图标都在下方自建（Dialog / Icon*），只依赖 react。
    const API = '/companion/api'
    const SECTION_ID = 'companion'
    /*
     * 伙伴下拉在 `conversation.input.left` 里的格子 id。
     * 用一个**自有** id（不是官方已有的），这样官方契约保证它被**追加**在内置项
     * 旁边，而不是替换掉某一格。
     */
    const COMPANION_SLOT_ID = 'companion-mode'
    /*
     * 「伙伴模式」预设 id —— 与 src/companion-preset.mjs 的 COMPANION_PRESET_ID
     * 必须保持一致：它是下拉显形的唯一闸门（会话挂了这个预设才显示伙伴下拉）。
     * client 不直接 require host 侧模块（bundle 边界），所以这里字面量 + 测试锁同步。
     */
    const COMPANION_PRESET_ID = 'companion-mode'

    const MD_TABS = [
      { file: 'SYSTEM.md', label: '提示词' },
      { file: 'SOUL.md', label: '个性' },
      { file: 'IDENTITY.md', label: '身份' },
      { file: 'USER.md', label: '用户' },
      { file: 'AGENTS.md', label: '准则' },
      { file: 'MEMORY.md', label: '记忆' },
    ]

    const CSS = [
      '.cmd-root{font-size:13px;color:var(--dsw-alias-label-primary,#1f1f1f);display:flex;flex-direction:column;gap:12px}',
      '.cmd-tabs{display:flex;align-items:flex-end;gap:22px;margin-top:2px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}',
      '.cmd-tab{cursor:pointer;background:none;border:0;padding:7px 1px 9px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8c8c8c);position:relative}',
      '.cmd-tab:hover{color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.cmd-tab[data-on="1"]{color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.cmd-tab[data-on="1"]:after{background:var(--dsw-alias-label-primary,#1f1f1f);content:"";border-radius:2px 2px 0 0;height:2px;position:absolute;bottom:-1px;left:0;right:0}',
      '.cmd-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4a7dff);outline-offset:2px;color:var(--dsw-alias-label-primary,#1f1f1f);border-radius:2px}',
      '.cmd-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));grid-auto-rows:1fr;gap:12px}',
      '.cmd-card{border:.5px solid var(--dsw-alias-border-l4,#e0e0e0);border-radius:20px;padding:0;display:flex;flex-direction:column;gap:0;background:transparent;overflow:hidden}',
      '.cmd-card:hover{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}',
      '.cmd-card-main{display:flex;flex-direction:column;flex:1;gap:8px;padding:14px 16px 12px}',
      '.cmd-card-head{display:flex;align-items:center;gap:8px}',
      '.cmd-card-name{font-size:15px;font-weight:600;line-height:1.4}',
      '.cmd-card-desc{color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:13px;line-height:1.55;min-height:42px;white-space:pre-wrap;overflow-wrap:anywhere;overflow:hidden;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical}',
      '.cmd-card-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-tertiary,#8c8c8c);font-size:11px;margin-top:auto}',
      '.cmd-card-foot{border-top:.5px solid var(--dsw-alias-border-l2,#e5e5e5);display:flex;justify-content:flex-end;gap:2px;padding:6px 10px}',
      '.cmd-icon-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:7px;color:var(--dsw-alias-label-tertiary,#8c8c8c);background:transparent;cursor:pointer;position:relative}',
      '.cmd-icon-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1,#f2f2f2);color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.cmd-icon-btn:disabled{opacity:.4;cursor:default}',
      '.cmd-icon-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,#fdecea);color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.cmd-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.cmd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.cmd-btn{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;border:1px solid var(--dsw-alias-border-l2,#d9d9d9);border-radius:16px;padding:0 14px;color:var(--dsw-alias-label-primary,#1f1f1f);background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;white-space:nowrap}',
      '.cmd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}',
      '.cmd-btn-primary{border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);background:var(--dsw-alias-button-primary-fill,#1f1f1f)}',
      '.cmd-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#333)}',
      '.cmd-text-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;height:28px;border:0;border-radius:14px;padding:0 10px;color:var(--dsw-alias-label-secondary,#6b6b6b);background:transparent;cursor:pointer;font:inherit;font-size:12.5px;line-height:18px}',
      '.cmd-text-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary,#1f1f1f);background:var(--dsw-alias-interactive-bg-hover,#f2f2f2)}',
      '.cmd-input{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);padding:9px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:13px}',
      '.cmd-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.cmd-input::placeholder{color:var(--dsw-alias-label-dimmed,#9a9a9a)}',
      '.cmd-textarea{width:100%;box-sizing:border-box;min-height:360px;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font-family:ui-monospace,Consolas,monospace;font-size:12.5px;line-height:1.6;resize:vertical}',
      '.cmd-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.cmd-hint{color:var(--dsw-alias-label-tertiary,#6b6b6b)}',
      '.cmd-err{color:var(--dsw-alias-state-error-primary,#c0392b)}',
      '.cmd-ok{color:var(--dsw-alias-state-success-primary,#2f9e44)}',
      '.cmd-field{display:flex;flex-direction:column;gap:6px}',
      '.cmd-field-label{color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:12px;font-weight:500}',
      '.cmd-set-row{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;min-width:0;min-height:52px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2,#e5e5e5);color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}',
      '.cmd-set-label{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.cmd-set-label b{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#1f1f1f);line-height:21px}',
      '.cmd-set-label span{font-size:11px;color:var(--dsw-alias-label-tertiary,#8c8c8c);line-height:17px}',
      '.cmd-perm{display:flex;flex-direction:column}',
      '.cmd-perm>.cmd-set-row{padding:10px 0 8px}',
      '.cmd-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:0 0 14px;max-width:420px}',
      '.cmd-fields label{display:flex;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:12px;line-height:16px;font-weight:500}',
      '.cmd-fields input{width:100%;box-sizing:border-box;height:34px;border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);border-radius:9px;padding:0 10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:13px}',
      '.cmd-fields input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.cmd-fields input:disabled{opacity:.45;cursor:default}',
      '.cmd-fields-single{grid-template-columns:minmax(0,1fr);max-width:260px;padding-bottom:6px}',
      // 平铺项（注入预算）与开关标题同级：同字号、同字重、同主色，别再比大类小一号。
      '.cmd-fields-lg label{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary,#1f1f1f);line-height:21px}',
      '.cmd-switch{box-sizing:border-box;background:var(--dsw-alias-border-l3,#b8b8b8);cursor:pointer;border:0;border-radius:10px;flex:none;width:36px;height:20px;padding:2px;position:relative;transition:background-color .14s}',
      '.cmd-switch-on{background:var(--dsw-alias-brand-primary,#4a7dff)}',
      '.cmd-switch:disabled{cursor:default;opacity:.5}',
      '.cmd-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a7dff);outline-offset:2px}',
      '.cmd-thumb{background:var(--dsw-alias-label-primary-foreground,#fff);border-radius:50%;width:16px;height:16px;transition:transform .12s;display:block}',
      '.cmd-switch-on .cmd-thumb{transform:translate(16px)}',
      /*
       * 输入框工具栏里的伙伴下拉 trigger —— 逐条对齐官方权限下拉的
       * PermissionSelect trigger 样式（dsh-client-ui-permission-presets 打包内联的
       * .trigger/.triggerLabel/.chevron），只换类名前缀：
       * 无边框、hover 用 interactive-bg-hover、13px/500 字重、4px 间距、箭头旋转。
       * 浮层本体由官方 primitives 的 Menu 自带（含半透明材质与键盘导航），不再自绘。
       */
      '.cmd-picker-trigger{font:inherit;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-secondary,#6b6b6b);cursor:pointer;background:none;border:none;outline:none;display:inline-flex;align-items:center;gap:4px;padding:0 4px 0 8px;height:28px;min-width:0;max-width:220px;border-radius:var(--dsw-radius-sm,8px);white-space:nowrap}',
      '.cmd-picker-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}',
      '.cmd-picker-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4a7dff))}',
      '.cmd-picker-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.cmd-picker-chevron{color:var(--dsw-alias-label-caption,#9a9a9a);flex:none;transition:transform .12s;display:inline-flex}',
      '.cmd-picker-chevron-open{transform:rotate(180deg)}',
      '.cmd-journal{display:flex;flex-direction:column;gap:6px;min-height:360px}',      '.cmd-journal-foot{margin-top:auto;padding-top:6px}',
      '.cmd-journal-row{display:flex;gap:12px;align-items:center;width:100%;box-sizing:border-box;text-align:left;font:inherit;color:inherit;background:transparent;cursor:pointer;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}',
      '.cmd-journal-row:hover{background:var(--dsw-alias-interactive-bg-hover,#f5f5f5)}',
      '.cmd-journal-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4a7dff);outline-offset:-1px}',
      '.cmd-journal-date{flex:none;width:108px;white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:500;font-size:12.5px;color:var(--dsw-alias-label-primary,#1f1f1f)}',
      '.cmd-journal-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#6b6b6b)}',
      '.cmd-viewer-dialog{width:min(640px,100%)}',
      '.cmd-viewer{border:.5px solid var(--dsw-alias-border-l4,#d9d9d9);background:var(--dsw-alias-bg-layer-2,#f7f7f7);max-height:min(52vh,480px);color:var(--dsw-alias-label-secondary,#6b6b6b);font-family:var(--dsw-font-mono,ui-monospace,Consolas,monospace);white-space:pre-wrap;overflow-wrap:anywhere;border-radius:10px;margin:0;padding:12px;font-size:12.5px;line-height:1.6;overflow:auto}',
      '.cmd-sep{height:1px;background:var(--dsw-alias-border-l2,#eee);margin:4px 0}',
      '.cmd-dialog{width:min(480px,100%)}',
      '.cmd-dialog-fields{display:flex;flex-direction:column;gap:12px}',
      // 自建兜底 Dialog 的定位与层级：原 Modal 自带这些，换成原生元素后必须自己补。
      // 遮罩 token 必须用 --dsw-alias-bg-mask-1（模态遮罩：亮 #0000003d / 暗 #00000080）。
      // 曾误用 --dsw-alias-bg-mask-drop —— 那是下拉浮层的遮罩，暗色主题值 #272730b3，
      // 呈蓝灰色，就是「弹窗背景发蓝」事故的根源。
      '.cmd-overlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45))}',
      '.cmd-dialog-sheet{width:min(560px,100%);max-height:min(80vh,720px);box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:16px 18px;border-radius:14px;border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);box-shadow:0 12px 40px rgba(0,0,0,.18)}',
      '.cmd-dialog-head{display:flex;flex-direction:column;gap:2px}',
      '.cmd-dialog-title{font-size:15px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}',
      '.cmd-dialog-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8c8c8c)}',
      '.cmd-dialog-foot{display:flex;justify-content:flex-end;gap:8px}',
      // 危险确认弹窗：勾选行样式只在自建兜底时用到（官方 RiskConfirmation 自带）。
      '.cmd-ack{display:flex;align-items:flex-start;gap:10px;margin-top:4px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#1f1f1f);cursor:pointer}',
      '.cmd-ack input{flex:none;width:16px;height:16px;margin:3px 0 0;accent-color:var(--dsw-alias-button-primary-fill,#4a7dff);cursor:pointer}',
      '.cmd-confirm-text{display:flex;align-items:flex-start;gap:10px;margin:0;color:var(--dsw-alias-label-secondary,#6b6b6b);font-size:14px;line-height:22px}',
      '.cmd-confirm-warn{flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary,#c0392b)}',
    ].join('\n')

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-companion-css]')) return
      const style = document.createElement('style')
      style.setAttribute('data-companion-css', '1')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /**
     * 官方 Modal（官方重命名会话弹窗同款）。取不到时为 null —— Dialog 退回自建实现。
     * 官方 Modal 遮罩用 --dsw-alias-bg-mask-1（黑色半透明），与自建兜底一致；
     * 自带 Escape 关闭、焦点圈定、右上角关闭钮（closeLabel 即其无障碍标签）。
     */
    function pickOfficialModal() {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        const Modal = primitives && primitives.Modal
        return typeof Modal === 'function' ? Modal : null
      } catch {
        return null
      }
    }
    const OfficialModal = pickOfficialModal()

    /**
     * 危险操作确认弹窗（官方权限预设「完整访问」确认同款）。取不到时为 null ——
     * ConfirmDialog 退回自建勾选确认。
     */
    function pickOfficialRiskConfirmation() {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        const Risk = primitives && primitives.RiskConfirmation
        return typeof Risk === 'function' ? Risk : null
      } catch {
        return null
      }
    }
    const OfficialRiskConfirmation = pickOfficialRiskConfirmation()

    /**
     * 弹窗容器：官方 Modal 可用时直接委托（与官方弹窗同款视觉与交互），
     * 取不到时退回自建实现。属性含义与官方 Modal 对齐：
     * title / description / footer / onClose / className / closeLabel。
     */
    function Dialog({ open, onClose, title, description, footer, className, closeLabel, children }) {
      if (OfficialModal) {
        return h(OfficialModal, {
          open,
          onClose,
          title,
          description,
          footer,
          className,
          closeLabel: closeLabel || '关闭',
        }, children)
      }
      if (!open) return null
      return h('div', {
        className: 'cmd-overlay',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': title,
        onClick: onClose,                       // 点遮罩关闭
      },
        h('div', {
          className: `cmd-dialog-sheet ${className || ''}`.trim(),
          onClick: (event) => event.stopPropagation(),   // 点内容不关闭
        },
          h('div', { className: 'cmd-dialog-head' },
            h('div', { className: 'cmd-dialog-title' }, title),
            description ? h('div', { className: 'cmd-dialog-sub' }, description) : null,
          ),
          children,
          footer ? h('div', { className: 'cmd-dialog-foot' }, footer) : null,
        ),
      )
    }

    /**
     * 危险确认弹窗（删除伙伴等）。官方 RiskConfirmation 是「Modal + 警告行 +
     * 我已知晓勾选框 + 确认/取消」的组合，确认键在勾选前禁用；取不到时退回
     * 同形态的自建实现（仍带勾选，不再退回 window.confirm）。
     */
    function ConfirmDialog({ open, title, warning, confirmLabel, cancelLabel, busy, onConfirm, onCancel }) {
      const [acknowledged, setAcknowledged] = React.useState(false)
      // 弹窗每次打开都从「未勾选」起步：上次会话的确认不能延续到下一次危险操作。
      React.useEffect(() => { if (open) setAcknowledged(false) }, [open])
      const footer = h(React.Fragment, null,
        h('button', { type: 'button', className: 'cmd-btn', disabled: busy, onClick: onCancel }, cancelLabel || '取消'),
        h('button', {
          type: 'button', className: 'cmd-btn cmd-btn-primary',
          disabled: busy || !acknowledged, onClick: onConfirm,
        }, confirmLabel || '删除'))
      if (OfficialRiskConfirmation) {
        return h(OfficialRiskConfirmation, {
          open,
          title,
          description: warning,
          acknowledgeLabel: '我已了解影响，继续',
          cancelLabel: cancelLabel || '取消',
          closeLabel: '关闭',
          confirmLabel: confirmLabel || '删除',
          acknowledged,
          onAcknowledgedChange: setAcknowledged,
          disabled: busy,
          onCancel,
          onConfirm,
        })
      }
      return h(Dialog, {
        open, onClose: onCancel, title, className: 'cmd-dialog',
        footer,
      },
        h('div', { className: 'cmd-confirm-text' },
          h('span', { className: 'cmd-confirm-warn', 'aria-hidden': 'true' }, '⚠'),
          h('p', null, warning)),
        h('label', { className: 'cmd-ack' },
          h('input', {
            type: 'checkbox', checked: acknowledged, disabled: busy,
            onChange: (event) => setAcknowledged(event.currentTarget.checked),
          }),
          h('span', null, '我已了解影响，继续')))
    }

    /* ── 卡片底部三个图标 ──
     *
     * 优先用官方 primitives 的同名图标（IconBrowseOutlineRegular / IconCopyOutlineRegular /
     * IconTrashOutlineRegular），与官方预设卡片视觉一致；取不到时退回内联 SVG。
     *
     * 图标名历史：0.1.5-rc.3 时代官方导出的是 *Outline16 尺寸后缀名；0.1.7-rc.2 起官方
     * 删除了全部 *Outline16 导出，改用 *OutlineRegular / *OutlineMedium 粗细变体命名
     * （官方 agent-preset 卡片自己也只用 IconBrowseOutlineRegular 等新名）。升级后探测
     * 落空会静默退回自绘 SVG —— 伙伴卡片图标「变回手绘」即此症状，改探测名即愈。
     *
     * 为什么必须带兜底：历史上曾在 factory 顶层直接解构该包，包取不到导致 factory
     * 抛错 → apply 从不执行 → ensureStyles 不跑 → 整页裸 HTML（见
     * docs/设置页裸样式-根因与修复.md）。而官方 dsh-client-ui-agent-preset 自己也在
     * 顶层 require 同一个包，说明它由前端模块系统在运行时注入，Node 里
     * require.resolve 失败并不代表浏览器里取不到 —— 所以不能静态判定，只能运行时探测。
     *
     * 探测放在 apply 之后、渲染之前，且只在渲染时取一次；try/catch 包住，
     * 任何一种失败都只是退回 SVG，不会波及样式与整页。
     */

    const ICON_PROPS = {
      width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.5,
      strokeLinecap: 'round', strokeLinejoin: 'round',
    }
    const SvgBrowse = () => h('svg', ICON_PROPS,
      h('circle', { cx: 7, cy: 7, r: 4.5 }), h('path', { d: 'M10.5 10.5 L14 14' }))
    const SvgCopy = () => h('svg', ICON_PROPS,
      h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
      h('path', { d: 'M10.5 5.5 V3.5 A1.5 1.5 0 0 0 9 2 H3.5 A1.5 1.5 0 0 0 2 3.5 V9 A1.5 1.5 0 0 0 3.5 10.5 H5.5' }))
    const SvgTrash = () => h('svg', ICON_PROPS,
      h('path', { d: 'M2.5 4.5 H13.5' }), h('path', { d: 'M6 4.5 V3 A1 1 0 0 1 7 2 H9 A1 1 0 0 1 10 3 V4.5' }),
      h('path', { d: 'M4 4.5 L4.8 13 A1 1 0 0 0 5.8 14 H10.2 A1 1 0 0 0 11.2 13 L12 4.5' }))

    /**
     * 取官方图标。任何一步失败都返回 null，由调用点退回内联 SVG。
     * 只读三个具名导出，不做整体解构 —— 缺其中一个不影响另外两个。
     */
    function pickOfficialIcon(name) {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        const Icon = primitives && primitives[name]
        return typeof Icon === 'function' || typeof Icon === 'object' ? Icon : null
      } catch {
        return null
      }
    }

    const IconBrowse = pickOfficialIcon('IconBrowseOutlineRegular') || SvgBrowse
    const IconCopy = pickOfficialIcon('IconCopyOutlineRegular') || SvgCopy
    const IconTrash = pickOfficialIcon('IconTrashOutlineRegular') || SvgTrash

    /**
     * 官方 Menu 浮层组件（权限下拉同款）。取不到时为 null —— 调用点退回
     * 仅 trigger 的静态展示，避免整个伙伴条目因缺组件而不渲染。
     */
    function pickOfficialMenu() {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        const Menu = primitives && primitives.Menu
        return typeof Menu === 'function' ? Menu : null
      } catch {
        return null
      }
    }
    const OfficialMenu = pickOfficialMenu()

    async function call(path, options) {
      const response = await fetch(`${API}${path}`, options)
      const text = await response.text()
      let payload = null
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
      }
      if (!response.ok) throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      // 2xx 但 body 为空/非 JSON：给一个能定位的错误，不要让它变成
      // 调用点的 "Cannot read properties of null"
      if (payload === null) throw new Error(`${path} 返回了空响应（HTTP ${response.status}）`)
      return payload
    }

    const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    function TabBar({ tabs, value, onChange }) {
      return h('div', { className: 'cmd-tabs' }, tabs.map((item) => h(
        'button',
        {
          key: item.key,
          type: 'button',
          className: 'cmd-tab',
          'data-on': item.key === value ? '1' : '0',
          onClick: () => onChange(item.key),
        },
        item.label,
      )))
    }

    /* ────────────────────────── 参数 TAB ────────────────────────── */

    function ParamsTab() {
      /** 服务端的值（保存成功后才更新）。 */
      const [saved, setSaved] = React.useState(null)
      const [message, setMessage] = React.useState('')
      /**
       * 编辑中的表单值。`null` = 还没编辑过，显示服务端的值。
       *
       * 改完**不立即生效**：攒在草稿里，点「保存」才提交（与 dsh-memory-md 一致）。
       * 这样一次只打一个接口、也不会出现「改到一半已经生效」的中间态。
       */
      const [draft, setDraft] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      /**
       * 拉一次服务端值。
       *
       * 抽成 useCallback 是为了让「保存失败」也能复用：失败时重新读一次，
       * 把服务端基线纠正回真实值。草稿（draft）不受影响，用户的编辑仍在，
       * 只是 dirty 会按最新基线重新判定。
       */
      const load = React.useCallback(() => {
        call('/settings')
          .then((data) => setSaved(data.settings))
          .catch((error) => setMessage(String(error.message)))
      }, [])

      React.useEffect(() => { load() }, [load])

      if (!saved) return h('div', { className: 'cmd-hint' }, message || '加载中…')

      /*
       * 表单值一律转成字符串：数字框要能承载「空」这个状态
       * （空 = 用默认值），而服务端返回的是 number。
       */
      const form = draft ?? {
        autoMemory: saved.autoMemory,
        reviewTurns: String(saved.reviewTurns ?? ''),
        reviewChars: String(saved.reviewChars ?? ''),
        contextBudget: String(saved.contextBudget ?? ''),
        budgetNotice: saved.budgetNotice,
      }
      const patch = (part) => setDraft({ ...form, ...part })

      /** 表单里有没有未保存的改动。 */
      const dirty =
        form.autoMemory !== saved.autoMemory ||
        form.reviewTurns !== String(saved.reviewTurns ?? '') ||
        form.reviewChars !== String(saved.reviewChars ?? '') ||
        form.contextBudget !== String(saved.contextBudget ?? '') ||
        form.budgetNotice !== saved.budgetNotice

      const toggle = (key) => h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': Boolean(form[key]),
        'aria-label': key,
        className: 'cmd-switch' + (form[key] ? ' cmd-switch-on' : ''),
        onClick: () => patch({ [key]: !form[key] }),
      }, h('span', { className: 'cmd-thumb' }))

      /**
       * 数字参数：标签在上、输入在下。
       *
       * 刻意**不把默认值写进标签或 placeholder**（与 dsh-memory-md 一致）：
       * 输入框留空即代表「用默认值」，由服务端归一化兜底。界面上不出现具体数字，
       * 默认值将来要调整也不必改文案。
       */
      const num = (key, label, min, step, unit, gated = true) => {
        // gated：是否受「自动记忆」总开关支配。注入预算与自动记忆无关，不该跟着变灰。
        const disabled = gated && !form.autoMemory
        return h('label', { key },
          unit ? `${label}（${unit}）` : label,
          h('input', {
            type: 'number',
            min,
            step,
            value: form[key],
            disabled,
            // 原样保留用户输入（含空串）：不在 onChange 里做归一化，
            // 归一化只在服务端做，避免「边打字边被改写」。
            onChange: (event) => patch({ [key]: event.target.value }),
          }))
      }

      /** 把草稿提交给服务端。归一化只在服务端做，这里不重复实现。 */
      const save = async () => {
        setSaving(true)
        setMessage('')
        try {
          const data = await call('/settings', json('PUT', {
            autoMemory: form.autoMemory,
            /*
             * ⚠️ 清空时提交 **null**，不能提交 undefined ——
             * `JSON.stringify({k: undefined})` 会把键整个丢掉，服务端收到的是空对象，
             * 于是「清空即用默认」根本不会发生（用户以为重置了，实际没变）。
             * `normalizeSetting` 把 null 当「回落默认」处理。
             */
            reviewTurns: form.reviewTurns.trim() === '' ? null : Number(form.reviewTurns),
            reviewChars: form.reviewChars.trim() === '' ? null : Number(form.reviewChars),
            contextBudget: form.contextBudget.trim() === '' ? null : Number(form.contextBudget),
            budgetNotice: form.budgetNotice,
          }))
          setSaved(data.settings)
          setDraft(null)
          setMessage('已保存，立即生效。')
        } catch (error) {
          setMessage(`保存失败：${error.message}`)
          // 重新拉一次服务端值：万一后端已经写进去了一部分（或并发的另一次保存
          // 成功了），这里显示的基线就会是脏的。重新读一遍纠正它。
          // 不动 draft —— 用户的编辑必须留着，否则一次失败就把输入吞掉了。
          load()
        } finally {
          setSaving(false)
        }
      }

      const setRow = (key, title, desc) => h('div', { className: 'cmd-set-row', key },
        h('span', { className: 'cmd-set-label' },
          h('b', null, title),
          desc ? h('span', null, desc) : null),
        toggle(key))

      // 后端还没返回预算字段时（旧进程）不显示 NaN，只留比例说明。
      // 这段并入「超限提醒」开关的说明里，不单独占一行——否则会把开关行的右端挤出对齐。
      const budgetChars = Number(saved.contextBudget)
      const budgetKnown = Number.isFinite(budgetChars) && budgetChars > 0
      const budgetHint = (budgetKnown ? `当前 ${budgetChars} 字符 ≈ ${Math.round(budgetChars * 0.47)} token。` : '') +
        '各文件按固定比例瓜分这份预算（MEMORY 25% / AGENTS 22% / SOUL 20% / IDENTITY 13% / SYSTEM 12% / USER 8%），' +
        '单个文件偏大但总量没超不会提示。'

      return h('div', { className: 'cmd-root' },
        h('div', { className: 'cmd-hint' }, '改动点「保存」后生效；运行中的会话下一个回合就会按新值走。'),
        h('div', { className: 'cmd-perm' },
          setRow('autoMemory', '自动记忆',
            '开：后台自动整理日记、更新记忆。关：不写日记也不动记忆，只有手动检索可用。'),
          h('div', { className: 'cmd-fields' },
            num('reviewTurns', '触发轮数', 1, undefined, '轮'),
            num('reviewChars', '触发字符数', 200, 200, '字符')),
          h('div', { className: 'cmd-sep' }),
          h('div', { className: 'cmd-fields cmd-fields-single cmd-fields-lg' },
            num('contextBudget', '注入预算', 2000, 1000, '字符', false)),
          setRow('budgetNotice', '超限提醒',
            '开：六个文件总量超出预算时，在提示词末尾附一段「请收敛」提醒，让模型自己精简。' +
            '关：只度量并打日志，不往提示词里加任何东西。两种情况都不硬截断。' + budgetHint)),
        h('div', { className: 'cmd-row' },
          h('button', {
            className: 'cmd-btn cmd-btn-primary',
            type: 'button',
            // 有未保存改动时才可点，避免无谓的接口调用。
            disabled: saving || !dirty,
            onClick: () => { void save() },
          }, saving ? '保存中…' : '保存'),
          dirty && !saving ? h('span', { className: 'cmd-hint' }, '有未保存的改动') : null,
          message ? h('span', { className: dirty ? 'cmd-hint' : 'cmd-ok' }, message) : null),
      )
    }

    /* ────────────────────────── 伙伴卡片 ────────────────────────── */

    function AgentList({ onOpen }) {
      const [agents, setAgents] = React.useState([])
      const [message, setMessage] = React.useState('')
      const [newName, setNewName] = React.useState('')
      const [copyFrom, setCopyFrom] = React.useState(null)   // 正在复制的源伙伴
      const [copyName, setCopyName] = React.useState('')
      const [copying, setCopying] = React.useState(false)
      const [copyError, setCopyError] = React.useState('')
      // 每张卡片的删除中状态：防止同一秒内双击导致备份目录重名
      const [deleting, setDeleting] = React.useState('')
      // 待确认删除的伙伴：非 null 时渲染 ConfirmDialog（官方 RiskConfirmation 同款形态）
      const [removeTarget, setRemoveTarget] = React.useState(null)

      const load = React.useCallback(() => {
        call('/agents').then((data) => setAgents(data.agents)).catch((error) => setMessage(String(error.message)))
      }, [])
      React.useEffect(() => { load() }, [load])

      const create = async () => {
        if (!newName.trim()) return setMessage('请输入昵称')
        try {
          const data = await call('/agents', json('POST', { name: newName.trim() }))
          setNewName('')
          setMessage(`已创建「${data.agent.name}」，新会话即可选用。`)
          load()
        } catch (error) {
          setMessage(`创建失败：${error.message}`)
        }
      }

      const remove = async (agent) => {
        if (deleting) return
        setDeleting(agent.id)
        try {
          const data = await call(`/agents/${agent.id}`, { method: 'DELETE' })
          setMessage(`已移动到备份：${data.archived}`)
          load()
        } catch (error) {
          setMessage(`删除失败：${error.message}`)
        } finally {
          setDeleting('')
          setRemoveTarget(null)
        }
      }

      const openCopy = (agent) => {
        setCopyFrom(agent)
        setCopyName(agent.name)
        setCopyError('')
        setCopying(false)
      }
      const closeCopy = () => setCopyFrom(null)

      const confirmCopy = async () => {
        if (!copyName.trim()) return setCopyError('请输入新伙伴的昵称')
        if (copying) return
        setCopying(true)
        setCopyError('')
        try {
          const data = await call(`/agents/${copyFrom.id}/copy`, json('POST', { name: copyName.trim() }))
          setMessage(`已复制为「${data.agent.name}」，新会话即可选用。`)
          setCopyFrom(null)
          load()
        } catch (error) {
          setCopyError(String(error.message))
          setCopying(false)
        }
      }

      const copyDialog = copyFrom ? h(Dialog, {
        open: true,
        onClose: closeCopy,
        title: '复制伙伴',
        closeLabel: '关闭',
        className: 'cmd-dialog',
        description: `以「${copyFrom.name}」为模板复制一个新伙伴，保留性格与内容，不带历史日记。`,
        footer: h(React.Fragment, null,
          h('button', { type: 'button', className: 'cmd-btn', disabled: copying, onClick: closeCopy }, '取消'),
          h('button', { type: 'button', className: 'cmd-btn cmd-btn-primary', disabled: copying || !copyName.trim(), onClick: confirmCopy }, copying ? '复制中…' : '复制')),
      }, h('div', { className: 'cmd-dialog-fields' },
        h('label', { className: 'cmd-field' },
          h('span', { className: 'cmd-field-label' }, '新伙伴昵称'),
          h('input', {
            className: 'cmd-input',
            value: copyName,
            autoFocus: true,
            spellCheck: false,
            placeholder: '新伙伴的昵称',
            onChange: (event) => { setCopyName(event.target.value); setCopyError('') },
            onKeyDown: (event) => { if (event.key === 'Enter') confirmCopy() },
          })),
        copyError ? h('p', { className: 'cmd-err', role: 'alert' }, copyError) : null)) : null

      return h('div', { className: 'cmd-root' },
        h('div', { className: 'cmd-row' },
          h('input', {
            className: 'cmd-input',
            style: { maxWidth: '220px' },
            placeholder: '新伙伴的昵称',
            value: newName,
            onChange: (event) => setNewName(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') create() },
          }),
          h('button', { className: 'cmd-btn cmd-btn-primary', type: 'button', onClick: create }, '新建伙伴')),
        h('div', { className: 'cmd-hint' }, message || '新建后请刷新 DSH，新会话里即可选择该伙伴。'),
        h('div', { className: 'cmd-sep' }),
        h('div', { className: 'cmd-cards' }, agents.map((agent) => h('article', { className: 'cmd-card', key: agent.id },
          h('div', { className: 'cmd-card-main' },
            h('div', { className: 'cmd-card-head' },
              h('span', { className: 'cmd-card-name' }, agent.name)),
            h('div', { className: 'cmd-card-desc' }, agent.description || '（还没有个性签名）'),
            h('div', { className: 'cmd-card-id' }, agent.id)),
          h('footer', { className: 'cmd-card-foot' },
            h('button', {
              className: 'cmd-icon-btn',
              type: 'button',
              title: '查看',
              'aria-label': `查看：${agent.name}`,
              onClick: () => onOpen(agent.id),
            }, h(IconBrowse)),
            h('button', {
              className: 'cmd-icon-btn',
              type: 'button',
              title: '复制',
              'aria-label': `复制：${agent.name}`,
              onClick: () => openCopy(agent),
            }, h(IconCopy)),
            h('button', {
              className: 'cmd-icon-btn cmd-icon-btn-danger',
              type: 'button',
              title: '删除',
              disabled: deleting === agent.id,
              'aria-label': `删除：${agent.name}`,
              onClick: () => setRemoveTarget(agent),
            }, h(IconTrash)))))),
        copyDialog,
        removeTarget ? h(ConfirmDialog, {
          open: true,
          title: `删除「${removeTarget.name}」`,
          warning: '伙伴将移动到备份目录：旧对话仍可查看，新会话不再出现。绑定的会话与提示词注入随之解除。',
          confirmLabel: '删除',
          busy: deleting === removeTarget.id,
          onConfirm: () => { void remove(removeTarget) },
          onCancel: () => setRemoveTarget(null),
        }) : null,
      )
    }

    /* ────────────────────────── 详情 ────────────────────────── */

    /** 日记默认只显示最近这些天，其余折叠，避免越积越长。 */
    const JOURNAL_VISIBLE_DAYS = 7

    function JournalTab({ id }) {
      const [rows, setRows] = React.useState([])
      const [loaded, setLoaded] = React.useState(false)
      const [viewing, setViewing] = React.useState(null)
      const [text, setText] = React.useState('')
      const [loading, setLoading] = React.useState(false)
      const [expanded, setExpanded] = React.useState(false)

      React.useEffect(() => {
        setLoaded(false)
        setExpanded(false)
        call(`/agents/${id}/journal`)
          .then((data) => setRows(data.journal))
          .catch(() => setRows([]))
          .finally(() => setLoaded(true))
      }, [id])

      const view = async (date) => {
        setViewing(date)
        setLoading(true)
        setText('')
        try {
          const data = await call(`/agents/${id}/journal/${date}`)
          setText(data.text || '（这天没有内容）')
        } catch (error) {
          setText(`读取失败：${error.message}`)
        } finally {
          setLoading(false)
        }
      }

      if (!loaded) {
        return h('div', { className: 'cmd-journal' },
          h('div', { className: 'cmd-hint' }, '加载中…'))
      }
      if (rows.length === 0) {
        return h('div', { className: 'cmd-journal' },
          h('div', { className: 'cmd-hint' }, '还没有日记。'))
      }

      const shown = expanded ? rows : rows.slice(0, JOURNAL_VISIBLE_DAYS)
      const hidden = rows.length - shown.length

      const viewer = h(Dialog, {
        open: viewing !== null,
        onClose: () => setViewing(null),
        title: viewing ? `日记 · ${viewing}` : '',
        closeLabel: '关闭',
        className: 'cmd-viewer-dialog',
        description: '这一天的日记内容，只读。',
        footer: h('button', { type: 'button', className: 'cmd-btn', autoFocus: true, onClick: () => setViewing(null) }, '关闭'),
      }, h('pre', { className: 'cmd-viewer' }, loading ? '读取中…' : text))

      return h('div', { className: 'cmd-journal' },
        shown.map((row) => h('button', {
          key: row.date,
          type: 'button',
          className: 'cmd-journal-row',
          onClick: () => view(row.date),
        },
        h('span', { className: 'cmd-journal-date' }, row.date),
        h('span', { className: 'cmd-journal-preview' }, row.preview || '（空）'))),
        hidden > 0 || expanded
          ? h('div', { className: 'cmd-row cmd-journal-foot' },
            h('button', {
              className: 'cmd-text-btn',
              type: 'button',
              onClick: () => setExpanded(!expanded),
            }, expanded ? '收起，只看最近 7 天' : `展开更早的 ${hidden} 天`))
          : null,
        viewer)
    }

    function AgentDetail({ id, onBack }) {
      const [agent, setAgent] = React.useState(null)
      const [name, setName] = React.useState('')
      const [description, setDescription] = React.useState('')
      const [tab, setTab] = React.useState(MD_TABS[0].file)
      const [draft, setDraft] = React.useState('')
      const [message, setMessage] = React.useState('')
      /** 保存失败时置为冲突提示：让用户知道该重新载入，而不是重试覆盖。 */
      const [conflict, setConflict] = React.useState(false)

      const load = React.useCallback(() => {
        call(`/agents/${id}`).then((data) => {
          setAgent(data.agent)
          setName(data.agent.name)
          setDescription(data.agent.description || '')
          setDraft(data.agent.files[MD_TABS[0].file] || '')
          setConflict(false)
        }).catch((error) => setMessage(String(error.message)))
      }, [id])
      React.useEffect(() => { load() }, [load])

      if (!agent) return h('div', { className: 'cmd-hint' }, message || '加载中…')

      /**
       * 当前页签有没有未保存的改动。
       *
       * 与「参数」页签的 dirty 判定同一套思路：拿草稿和载入时的基线比。
       * 这里没有这一步的话，编辑十分钟的内容会在切页签时被静默换掉。
       */
      const dirty = draft !== (agent.files[tab] || '')

      const pickTab = (file) => {
        if (file === tab) return
        /*
         * 切页签前确认：未保存的编辑不能无声丢弃。
         * 这里有意保留 window.confirm：拦截的是**同步流程中间**（函数内直接 return
         * 即可取消切换），换 Promise 形态的弹窗要把 pickTab 拆成两段状态机，
         * 且页签切换不是危险操作，浏览器级确认足够；页内危险操作（删除伙伴）
         * 走 ConfirmDialog（官方 RiskConfirmation 同款），不在此处。
         */
        if (dirty && typeof window !== 'undefined' && !window.confirm(`${tab} 有未保存的改动，放弃并切换吗？`)) return
        setTab(file)
        setDraft(agent.files[file] || '')
        setMessage('')
        setConflict(false)
      }

      const saveMeta = async () => {
        try {
          const data = await call(`/agents/${id}/meta`, json('PUT', { name, description }))
          setAgent(data.agent)
          setMessage('昵称/签名已保存。')
        } catch (error) {
          setMessage(`保存失败：${error.message}`)
        }
      }

      const saveFile = async () => {
        try {
          /*
           * 带上载入时该文件的版本指纹：后台自动记忆可能在我们编辑期间
           * 往同一文件追加过内容，服务端比对不一致会回 409。
           * 不带的话就是无条件整文件覆盖——那条记忆会静默消失。
           */
          const data = await call(`/agents/${id}/file`, json('PUT', {
            file: tab,
            content: draft,
            baseVersion: agent.versions ? agent.versions[tab] : undefined,
          }))
          setAgent({
            ...agent,
            files: { ...agent.files, [tab]: draft },
            versions: { ...(agent.versions || {}), [tab]: data.version },
          })
          setConflict(false)
          setMessage(`${tab} 已保存。若开着「会话内冻结提示词」，需新开对话才生效。`)
        } catch (error) {
          const text = String(error.message)
          setMessage(`保存失败：${text}`)
          // 409 = 文件被后台改过：提示重新载入，而不是让用户反复重试覆盖
          if (text.includes('已被后台修改')) setConflict(true)
        }
      }

      const tabs = MD_TABS.map((item) => ({ key: item.file, label: item.label }))
      tabs.push({ key: 'journal', label: '日记' })

      return h('div', { className: 'cmd-root' },
        h('div', { className: 'cmd-row' },
          h('button', { className: 'cmd-text-btn', type: 'button', onClick: onBack }, '← 返回'),
          h('span', { className: 'cmd-hint' }, id)),
        h('label', { className: 'cmd-field' },
          h('span', { className: 'cmd-field-label' }, '昵称'),
          h('input', { className: 'cmd-input', value: name, onChange: (event) => setName(event.target.value) })),
        h('label', { className: 'cmd-field' },
          h('span', { className: 'cmd-field-label' }, '个性签名'),
          h('input', { className: 'cmd-input', value: description, onChange: (event) => setDescription(event.target.value) })),
        h('div', { className: 'cmd-row' },
          h('button', { className: 'cmd-btn cmd-btn-primary', type: 'button', onClick: saveMeta }, '保存昵称/签名'),
          h('span', { className: 'cmd-hint' }, message)),
        h('div', { className: 'cmd-sep' }),
        h(TabBar, { tabs, value: tab, onChange: pickTab }),
        tab === 'journal'
          ? h(JournalTab, { id })
          : h('div', { className: 'cmd-root' },
            h('textarea', { className: 'cmd-textarea', value: draft, onChange: (event) => setDraft(event.target.value) }),
            h('div', { className: 'cmd-row' },
              // 有未保存改动时才可点：与「参数」页签同一套门控，避免无谓的接口调用
              h('button', {
                className: 'cmd-btn cmd-btn-primary',
                type: 'button',
                disabled: !dirty,
                onClick: saveFile,
              }, '保存'),
              h('button', {
                className: 'cmd-text-btn',
                type: 'button',
                disabled: !dirty,
                onClick: () => {
                  setDraft(agent.files[tab] || '')
                  setMessage('')
                  setConflict(false)
                },
              }, '取消'),
              /*
               * 冲突时给一条**可执行的**出路：重新载入会丢掉本地草稿，
               * 所以只在用户明确点了才做，且顺带把最新内容拉回来。
               */
              conflict
                ? h('button', {
                  className: 'cmd-text-btn',
                  type: 'button',
                  onClick: () => {
                    setMessage('')
                    load()
                  },
                }, '重新载入')
                : null,
              dirty && !conflict ? h('span', { className: 'cmd-hint' }, '有未保存的改动') : null,
              message ? h('span', { className: conflict ? 'cmd-err' : 'cmd-hint' }, message) : null)),
      )
    }

    /* ────────────────────── 输入框工具栏的伙伴下拉 ──────────────────────
     *
     * 挂在官方 slot `conversation.input.left`（"Compact controls at the left of
     * the composer tool row"）。官方对该 slot 的约定是：
     *
     *   "Use an id of your own: a fresh id is added **beside** the shipped
     *    entries, while reusing a shipped id puts you in THAT cell and replaces it."
     *
     * 所以我们用一个自有 id —— **不会顶掉官方任何一个控件**。
     *
     * ## 为什么在输入框而不是"新建对话"那一屏
     *
     * 新建对话的 Hero 区只有三个 slot（brand.mark / workspace / agentPreset），
     * 全是 `single` 且被官方占据；而 slot 只能由**声明它的组件**渲染
     * （官方原话："Declaring is claiming"），插件无法往那一行里追加控件。
     * 输入框工具栏是 `list`、可追加，且它在新建对话时同样可见 ——
     * 于是"开对话前选伙伴"这个交互得以保留。
     *
     * ## 锁定规则
     *
     * - `blank`（会话还没开始）：可选
     * - 已经开始（首轮已发出）：只读展示，改不了 —— 见官方
     *   `SessionSnapshot.awaitingFirstTurn` 的语义
     */

    /**
     * 会话是否还处于"可改绑定"的窗口。
     *
     * ## 三态，不是两态
     *
     * 这里必须区分**三种**情况，而不是"可选 / 锁定"两种：
     *
     *   1. **未就绪**：快照还没装载，`blank` / `promptAttempted` 都没有权威值
     *   2. **可选**：会话还没开始（`blank !== false` 且首轮未提交）
     *   3. **锁定**：已经开始，绑定不可改
     *
     * 早先的写法（`if (!session) return false` + 两个字段判断）把第 1 种
     * 并进了第 2 种 —— `{}` 会穿过两个 `=== ` 判断落到 `return true`。
     * 后果：会话快照存在但字段尚未装上时，输入栏渲染出**可交互**的下拉，
     * 而此刻会话可能其实已经开始，用户改完会被服务端以 409 拒绝
     * （W8 那条红色错误提示的触发路径之一）。
     *
     * 未就绪按**锁定**处理：宁可短暂只读，也不放行一个可能无效的写入。
     * 与 README「锁定态只读」的取舍一致 —— 错误的代价小得多。
     */
    function canPickCompanion(session) {
      if (!session) return false
      // 未就绪：关键字段一个都没装上 → 不是"可选"，是"还不知道"
      if (session.blank === undefined && session.promptAttempted === undefined) return false
      // 还没开始：可选。已经跑起来（首轮已提交）：锁定。
      if (session.blank === false) return false
      if (session.promptAttempted === true) return false
      return true
    }

    /** useSession 缺失时的空实现：保证 hook 调用次数恒定，不破坏 hook 顺序。 */
    const noSession = () => undefined
    /** useSessions 缺失时的空实现：同上，保持 hook 次数恒定。 */
    const noSessions = () => undefined

    /**
     * 当前会话挂的是哪个官方预设。
     *
     * 读法照抄官方 AgentPresetLabel（dsh-client-ui-agent-preset/lib/client.js:359-363）：
     * `useSessions` 的列表投影里，每个会话的 `projectionValues.agentPreset`。
     * blank 新会话 / 旧版本没有该值时返回 undefined —— 与官方同语义。
     */
    function useSessionPreset(props) {
      const useSessions = props.useSessions ?? noSessions
      const sessionId = props.sessionId
      return useSessions((state) => {
        const value = state?.byId?.[sessionId]?.projectionValues?.agentPreset
        return typeof value === 'string' ? value : undefined
      })
    }

    function CompanionPicker(props) {
      /*
       * ⚠️ 会话身份**不能**取 `props.session` —— 该 slot 的官方 props 表里
       * 没有这个名字。官方声明处是 `renderSlot("conversation.input.left", {})`
       * （dsh-client-ui-conversation/lib/client.js:17447），传入的是**空对象**；
       * 会话身份由 standard kit 以 `sessionId` + `useSession` 注入。
       *
       * 用不存在的 prop 会让 session 恒为 undefined，`canPickCompanion` 于是
       * 判为"已锁定"，控件退化成只读小标签 —— 下拉框永远出不来。
       *
       * ## 显形条件：仅「伙伴模式」预设
       *
       * 伙伴下拉只在会话挂了本插件注册的「伙伴模式」预设时出现；
       * 其他任何预设（standard / standard-gitbash / ptc…）**完全不渲染**，
       * 编码会话的输入栏与官方原样一致，一个像素都不占。
       * 注意判断放在**所有 hook 之后**：不能因为不显形就少调 hook。
       */
      const sessionId = props.sessionId
      const useSession = props.useSession ?? noSession
      /*
       * ⚠️ 只订阅用得到的两个字段，**不要** `useSession((snapshot) => snapshot)`。
       *
       * 这个控件挂在输入栏，而会话快照在流式输出期间每来一个 token 就更新。
       * 传整个快照 = 返回值每次都是新对象 = 每次 token 都让本控件重渲染一轮，
       * 白白跟着流式输出跑。
       *
       * 我们真正读的只有 `blank` 与 `promptAttempted`（见 canPickCompanion），
       * 两者都是布尔，值不变时引用不变，宿主就不会重渲染。
       * 官方各 UI 包一律这么写（trajectory 选 loadingOlder/hasMore、
       * schedule 选 openState —— dsh-client-ui-trajectory/lib/client.js:8365-8367）。
       */
      const session = useSession((snapshot) => (
        snapshot === undefined || snapshot === null
          ? undefined
          : { blank: snapshot.blank, promptAttempted: snapshot.promptAttempted }
      ))
      const presetId = useSessionPreset(props)
      const [state, setState] = React.useState({ phase: 'loading', list: [], current: null, open: false, error: '' })
      const locked = !canPickCompanion(session)
      // W8：pick 失败提示的自动清除计时器。hook 必须在早 return 之前调用。
      const pickErrorTimer = React.useRef(null)

      /*
       * ⚠️ 这个 effect 必须在显形闸门**之前**声明。
       *
       * 历史 bug：闸门 `if (presetId !== COMPANION_PRESET_ID) return null`
       * 曾写在 effect 之前 —— 非伙伴会话首次渲染早 return（少调一个 hook），
       * 用户随后把预设切成伙伴模式、投影更新后重渲染，hook 数从 3 变 4，
       * React 抛 "Rendered more hooks than during the previous render"，
       * 被官方 SlotErrorBoundary 捕获后整个 slot 条目被 abdicate 摘除 ——
       * 表现为「hero 已显示伙伴模式、伙伴下拉却永远不出现」，console 之外无任何提示。
       * 规则：早 return 只能放在**全部** hook 之后；「不显形不发请求」改由
       * effect 体内的闸门保证。
       */
      React.useEffect(() => {
        if (presetId !== COMPANION_PRESET_ID) return
        let alive = true
        /*
         * 路径是 `/companions`，**不是** `/api/companions`。
         *
         * `API` 已经带了 `/api` 段（见文件顶部的 `const API = '/companion/api'`），
         * 再写一次会拼成 `/companion/api/api/companions` → 404 → 下面 catch 把
         * phase 置为 error → `return null`，于是**静默什么都不显示**。
         * 带上 session 是为了让服务端回 `current`（当前绑定）。
         */
        const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
        call(`/companions${query}`)
          .then((payload) => {
            if (!alive) return
            setState((prev) => ({ ...prev, phase: 'ready', list: payload.companions || [], current: payload.current ?? null }))
          })
          .catch(() => {
            if (alive) setState((prev) => ({ ...prev, phase: 'error' }))
          })
        return () => {
          alive = false
          /*
           * 卸载时必须收回失败提示的计时器。
           *
           * 这个计时器此前只在下一次 pick 时被清（见 pick 里的守卫），
           * effect 没有清理函数 —— 下拉随会话切换被卸载后，5 秒计时器仍会
           * 触发 setState 打在已卸载组件上。真实 React 里是警告 + 状态竞态，
           * 并发模式下更明显。参照 omdsh-chatmode 的约定：每个 effect
           * 都要有配套的清理，卸载后不留任何东西。
           */
          if (pickErrorTimer.current) {
            clearTimeout(pickErrorTimer.current)
            pickErrorTimer.current = null
          }
        }
        /*
         * ⚠️ 依赖必须含 presetId。
         *
         * 历史 bug：依赖曾只有 [sessionId] —— 会话原地从标准切到伙伴模式时
         * sessionId 不变，effect 不重跑，phase 卡在 'loading' → 永远 return null。
         * 表现为「切预设不显示，点去别的会话再点回来才显示」（换会话触发
         * session-scope 条目重挂载，替 effect 补跑了一次）。把 presetId 放进
         * 依赖后，预设一到位就重新拉取；切走再切回多一次无害的重复请求。
         */
      }, [sessionId, presetId])

      async function pick(id) {
        setState((prev) => ({ ...prev, open: false }))
        try {
          const payload = await call('/companion', json('PUT', { companion: id, session: sessionId }))
          setState((prev) => ({ ...prev, current: payload.current ?? null, error: '' }))
        } catch (error) {
          /*
           * W8：失败必须看得见。这个下拉挂在输入栏，没有别的状态区可借，
           * 所以把错误短暂顶掉触发器文字（红色），5 秒后自动还原——
           * 静默失败会让用户以为选上了，实际系统提示词根本没换。
           */
          const message = String(error && error.message ? error.message : error)
          if (pickErrorTimer.current) clearTimeout(pickErrorTimer.current)
          pickErrorTimer.current = setTimeout(() => {
            pickErrorTimer.current = null
            setState((prev) => ({ ...prev, error: '' }))
          }, 5000)
          setState((prev) => ({ ...prev, error: message }))
        }
      }

      const showError = typeof state.error === 'string' && state.error !== ''

      /*
       * ── 显形闸门：仅「伙伴模式」预设 ──
       * 必须位于所有 hook（useState / useEffect）之后 —— 见上方 effect 前的说明。
       * 不显形时连 phase='loading' 的分支都不该走到，直接整体不渲染。
       */
      if (presetId !== COMPANION_PRESET_ID) return null

      if (state.phase === 'loading') return null
      if (state.phase === 'error') return null
      // 一个伙伴都没有：不占位置（用户还没建伙伴时不该出现空下拉）
      if (state.list.length === 0) return null

      const currentName = state.current
        ? ((state.list.find((item) => item.id === state.current) || {}).name || state.current)
        : '无'

      if (locked) {
        // 锁定后只读展示：开对话后绑定不可改（用户明确要求）。
        // 锁定态不可能是 pick 失败的来源（锁定时下拉本就不可交互），不需要 error 分支。
        return h('span', { className: 'cmd-picker-trigger', title: '本次对话已开始，伙伴不可更改' }, `伙伴：${currentName}`)
      }

      // W8：选伙伴失败（如 409 / 网络错误）——红色短暂顶掉触发器文字，5 秒后还原。
      if (showError) {
        return h('span', {
          className: 'cmd-picker-trigger cmd-err',
          title: state.error,
          onClick: () => setState((prev) => ({ ...prev, error: '', open: false })),
        }, `伙伴选择失败：${state.error}`)
      }

      /*
       * 样式对齐官方权限下拉（dsh-client-ui-permission-presets 的 PermissionSelect）：
       * - 用官方 primitives 的 Menu（浮层/键盘导航/选中勾全由官方管）；
       * - trigger 是"文字 + 旋转箭头"的无边框内联控件，与权限下拉同排同观感；
       * - 菜单项就是伙伴名，不加"（用官方提示词）"之类的行为说明 —— 选择即生效，
       *   无伙伴 = 会话不注册任何 persona section，官方提示词原样生效（见 host 半）。
       */
      const items = [
        { id: '__none__', label: '无' },
        ...state.list.map((item) => ({ id: item.id, label: item.name || item.id })),
      ]
      const currentValue = state.current ?? '__none__'
      if (!OfficialMenu) {
        // 官方 Menu 缺席（极旧版 dsh）：退化为只读文字，至少占位可见。
        return h('span', { className: 'cmd-picker-trigger' }, `伙伴：${currentName}`)
      }
      return h(OfficialMenu, {
        open: state.open,
        items,
        selectedId: currentValue,
        onSelect: (id) => { setState((prev) => ({ ...prev, open: false })); pick(id === '__none__' ? null : id) },
        onClose: () => setState((prev) => ({ ...prev, open: false })),
        side: 'top',
        portal: true,
        anchor: h('button', {
          type: 'button',
          className: 'cmd-picker-trigger',
          onClick: () => setState((prev) => ({ ...prev, open: !prev.open })),
        },
          h('span', { className: 'cmd-picker-label' }, `伙伴：${currentName}`),
          h('span', { className: `cmd-picker-chevron${state.open ? ' cmd-picker-chevron-open' : ''}`, 'aria-hidden': true }, '▾'),
        ),
      })
    }

    /* ────────────────────────── 入口 ────────────────────────── */

    function PartnerSettings() {
      const [tab, setTab] = React.useState('agents')
      const [openId, setOpenId] = React.useState(null)

      return h('div', { className: 'cmd-root' },
        h(TabBar, {
          tabs: [{ key: 'agents', label: '伙伴' }, { key: 'params', label: '参数' }],
          value: tab,
          onChange: (key) => {
            setTab(key)
            if (key !== 'agents') setOpenId(null)
          },
        }),
        tab === 'params'
          ? h(ParamsTab)
          : (openId
            ? h(AgentDetail, { id: openId, onBack: () => setOpenId(null) })
            : h(AgentList, { onOpen: setOpenId })),
      )
    }

    function apply(ctx) {
      // 先插样式：即使后面拿不到 slots，页面至少是带样式的（不是裸 HTML）。
      ensureStyles()
      // 两种取服务形态：cordis 的 ctx.get(name)，以及直接挂在 ctx 上的属性。
      // ctx 缺 get 时必须能安全退化，否则这里抛错会把整个设置页带崩——
      // 这正是「整页裸样式」那类故障的另一种触发路径。
      const slots = ctx.slots !== undefined
        ? ctx.slots
        : (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: SECTION_ID, order: 21, label: '伙伴设置' },
        PartnerSettings,
      ))
      /*
       * 伙伴下拉：挂在输入框工具栏左侧，用**自有 id** 追加，
       * 不占用官方任何一格（官方契约："a fresh id is added beside the
       * shipped entries"）。取不到该 slot 时静默跳过，不影响设置页。
       */
      try {
        slots.inject('conversation.input.left', () => slots.register(
          { name: 'conversation.input.left', id: COMPANION_SLOT_ID, order: 10, label: '伙伴' },
          CompanionPicker,
        ))
      } catch {
        /* 该 slot 不存在（旧版 dsh）时不影响其余功能 */
      }
    }

    return { apply, inject: ['slots'], name: 'companion-client' }
  },
})
