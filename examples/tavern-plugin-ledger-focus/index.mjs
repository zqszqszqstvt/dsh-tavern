import { pickLedgerEntities, focusedLedgerContext, assertLedgerFocus, LEDGER_LOOKUP_TOOL, lookupLedgerEntities } from './focus.mjs'

export const name = 'dsh-tavern-ledger-focus'
export const inject = ['tavern']
const PROMPT_LIMIT = 20000

// Only assistant prose can justify widening scope; player intentions are not facts.
export function storyEvidence(text) {
  return [...String(text).matchAll(/\[正文\]\n([\s\S]*?)(?=\n\n\[(?:玩家|正文)\]\n|\n\n【第 \d+ 轮】\n|$)/g)].map(match => match[1]).join('\n\n')
}

export function createConsolidator(tavern) {
  return async function consolidate({ gameId, from, through, text, ledger, rules, tool, signal }) {
    signal?.throwIfAborted()
    // No partial story or truncated rows: Tavern's own full-context path handles oversized batches.
    let focus = pickLedgerEntities(ledger, text)
    const context = focusedLedgerContext(ledger, focus)
    const prompt = rules.replace(/\bledger_submit\b/g, 'focused_ledger_submit') + '\n\n【整理范围】第 ' + from + '–' + through + ' 轮。\n' + context +
      '\n\n【待整理剧情】\n' + text + '\n\n只用 focused_ledger_submit 提交增量（格式同 ledger_submit），不要用文字代替提交。详情漏选时先用 ledger_lookup。'
    if (prompt.length > PROMPT_LIMIT) return null
    const evidence = storyEvidence(text)
    let delta = null
    let overflow = false
    await tavern.runTask({ gameId, prompt, signal, tools: [
      { ...LEDGER_LOOKUP_TOOL, execute: async args => {
        signal?.throwIfAborted()
        if (delta !== null) return { ok: false, error: '已提交，不能继续查询或修改' }
        const expanded = lookupLedgerEntities(ledger, focus, args, text, evidence)
        const updated = focusedLedgerContext(ledger, expanded)
        if (JSON.stringify({ ok: true, context: updated }).length > PROMPT_LIMIT) {
          overflow = true
          throw new Error('查询上下文过大，本次交由 Tavern 完整整理')
        }
        focus = expanded
        return { ok: true, context: updated }
      } },
      { name: 'focused_ledger_submit', description: tool.description, parameters: tool.parameters, execute: async args => {
        signal?.throwIfAborted()
        if (delta !== null) return { ok: false, error: '已提交，请结束任务' }
        assertLedgerFocus(ledger, focus, args)
        delta = structuredClone(args)
        return { ok: true }
      } }
    ] })
    signal?.throwIfAborted()
    // Tavern owns schema validation, atomic persistence and fallback on invalid deltas.
    return overflow || delta === null ? null : { delta }
  }
}

export function apply(ctx) {
  if (ctx.tavern.apiVersion < 6 || typeof ctx.tavern.replaceLedger !== 'function') {
    throw new Error('台账筛选插件需要 Tavern 插件接口第 6 版，请先更新 Tavern')
  }
  ctx.tavern.replaceLedger({ consolidate: createConsolidator(ctx.tavern) })
}
