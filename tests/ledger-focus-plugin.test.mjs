import test from 'node:test'
import assert from 'node:assert/strict'
import { createConsolidator, storyEvidence, apply } from '../examples/tavern-plugin-ledger-focus/index.mjs'
import { createPluginTaskExecution } from '../tavern-plugin/lib/domain/plugin-task-execution.js'
import { applyLedgerDelta, LEDGER_RULES, LEDGER_SUBMIT_TOOL } from '../tavern-plugin/lib/domain/story-ledger.js'
const ledger = () => ({ npcs: [{ name: '角色甲', ties: '角色乙是同伴', condition: '受伤', updatedTurn: 1 }, { name: '角色乙', condition: '健康', updatedTurn: 1 }, { name: '角色丙', updatedTurn: 1 }], items: [], scenes: [{ path: ['客栈'], updatedTurn: 1 }], itemLog: [] })
const input = () => ({ gameId: 'game', from: 2, through: 2, text: '【第 2 轮】\n[玩家]\n去找角色丙。\n\n[正文]\n她在客栈包扎伤口。', ledger: ledger(), rules: '仅按事实整理。调用 ledger_submit 提交。', tool: { description: '提交', parameters: { type: 'object' } }, signal: new AbortController().signal })
test('only actual assistant prose supplies lookup evidence', () => {
 const value=input();assert.equal(storyEvidence(value.text),'她在客栈包扎伤口。')
 assert.equal(storyEvidence('[玩家]\n空白'),'')
 assert.equal(storyEvidence(value.text+'\n\n【第 3 轮】\n[玩家]\n后续\n\n[正文]\n第二段。'),'她在客栈包扎伤口。\n\n第二段。')
})
test('uses v6 and needs no private Tavern imports', () => {
 let registered;apply({tavern:{apiVersion:6,replaceLedger(value){registered=value}}});assert.equal(typeof registered.consolidate,'function')
 assert.throws(()=>apply({tavern:{apiVersion:5}}),/第 6 版/)
})
test('lookup resolves a pronoun before scoped submit; nothing mutates original ledger',async()=>{
 const value=input();value.text=value.text.replace('去找角色丙。','包扎。');const before=structuredClone(value.ledger)
 const consolidate=createConsolidator({async runTask({tools,prompt,signal}){
  assert.equal(signal,value.signal);assert.match(prompt,/仅按事实整理/);assert.match(prompt,/调用 focused_ledger_submit 提交/)
  const lookup=tools.find(t=>t.name==='ledger_lookup'),submit=tools.find(t=>t.name==='focused_ledger_submit')
  await assert.rejects(()=>lookup.execute({kind:'npcs',names:['角色甲'],evidence:'包扎。'}))
  await lookup.execute({kind:'npcs',names:['角色甲'],evidence:'她在客栈包扎伤口。'})
  await assert.rejects(()=>submit.execute({npcs:{update:[{name:'角色乙',condition:'受伤'}]}}))
  await submit.execute({npcs:{update:[{name:'角色甲',condition:'已包扎'},{name:'角色乙',ties:'角色甲是同伴'}]}})
  const late=await lookup.execute({kind:'npcs',names:['角色丙'],evidence:'她在客栈包扎伤口。'});assert.equal(late.ok,false)
 }})
 const result=await consolidate(value);assert.equal(result.delta.npcs.update[0].condition,'已包扎');assert.deepEqual(value.ledger,before)
})
test('oversized prompt falls back without dropping story or splitting entries',async()=>{
 let calls=0;const consolidate=createConsolidator({async runTask(){calls++}})
 const value=input();value.text='正文'.repeat(11000);assert.equal(await consolidate(value),null);assert.equal(calls,0)
})
test('missing submission falls back, empty delta is valid, model failure propagates for host fallback',async()=>{
 assert.equal(await createConsolidator({async runTask(){}})(input()),null)
 assert.deepEqual(await createConsolidator({async runTask({tools}){await tools[1].execute({})}})(input()),{delta:{}})
 await assert.rejects(()=>createConsolidator({async runTask(){throw new Error('timeout')}})(input()),/timeout/)
})
test('abort cannot return a staged delta',async()=>{
 const controller=new AbortController(),value=input();value.signal=controller.signal
 await assert.rejects(()=>createConsolidator({async runTask({tools}){await tools[1].execute({});controller.abort()}})(value),{name:'AbortError'})
})
test('separate games never share lookup scope or a staged delta',async()=>{
 const requests=[];const consolidate=createConsolidator({runTask:args=>new Promise(resolve=>requests.push({args,resolve}))})
 const a=input(),b=input();a.gameId='a';b.gameId='b';a.text=b.text='[正文]\n她在客栈包扎伤口。'
 const pendingA=consolidate(a),pendingB=consolidate(b)
 await requests[0].args.tools[0].execute({kind:'npcs',names:['角色甲'],evidence:'她在客栈包扎伤口。'})
 await requests[0].args.tools[1].execute({npcs:{update:[{name:'角色甲',condition:'已包扎'}]}})
 await assert.rejects(()=>requests[1].args.tools[1].execute({npcs:{update:[{name:'角色甲',condition:'已包扎'}]}}))
 requests[0].resolve();requests[1].resolve();assert.ok((await pendingA).delta);assert.equal(await pendingB,null)
})

test('an oversized lookup result falls back instead of letting runTask truncate its JSON',async()=>{
 const value=input();value.text='[正文]\n她在客栈看到了角色甲。';value.ledger.npcs.push({name:'远方记录',desc:'\"'.repeat(12000)})
 // The large row is omitted from initial details; lookup explicitly requests it with real prose evidence.
 value.text='[正文]\n她在客栈阅读那份记录。'
 const consolidate=createConsolidator({async runTask({tools}){
  await assert.rejects(()=>tools[0].execute({kind:'npcs',names:['远方记录'],evidence:'那份记录'}),/查询上下文过大/)
  await tools[1].execute({})
 }})
 assert.equal(await consolidate(value),null)
})
test('a duplicate submit cannot replace the first accepted delta',async()=>{
 const first={items:{add:[{name:'药膏',qty:1}]}}
 const consolidate=createConsolidator({async runTask({tools}){
  await tools[1].execute(first);first.items.add[0].name='外部改写'
  assert.equal((await tools[1].execute({})).ok,false)
 }})
 assert.equal((await consolidate(input())).delta.items.add[0].name,'药膏')
})

test('real Tavern task bridge accepts plugin tools and returns a delta its ledger validator can save', async () => {
 const value = input(), errors = []
 value.ledger = applyLedgerDelta(null, { npcs: { add: [{ name: '角色甲', condition: '受伤' }] }, scenes: { add: [{ path: ['客栈'], desc: '供旅客住宿的木楼' }] } }, 1)
 value.text = '[正文]\n她在客栈包扎伤口。'
 value.rules = LEDGER_RULES
 value.tool = LEDGER_SUBMIT_TOOL
 const bridge = createPluginTaskExecution({
  requireGame: async gameId => ({ sessionId: gameId }), choicesFor: async () => ({ disabled: new Set() }),
  reservedToolNames: new Set(['ledger_submit']), recordError: (...args) => errors.push(args),
  settlementTasks: new Map(), manualTasks: new Map(),
  runTask: async ({ tools, call, signal }) => {
   assert.equal(signal, value.signal)
   assert.deepEqual(tools.map(tool => tool.name), ['ledger_lookup', 'focused_ledger_submit'])
   assert.equal(JSON.parse(await call('ledger_lookup', { kind: 'npcs', names: ['角色甲'], evidence: '她在客栈包扎伤口。' })).ok, true)
   assert.equal(JSON.parse(await call('focused_ledger_submit', { npcs: { update: [{ name: '角色甲', condition: '伤口已包扎' }] } })).ok, true)
   return { text: '' }
  }
 })
 const consolidate = createConsolidator({ runTask: args => bridge.runAgent('dsh-tavern-ledger-focus', args) })
 const result = await consolidate(value)
 assert.equal(applyLedgerDelta(value.ledger, result.delta, 2).npcs[0].condition, '伤口已包扎')
 assert.equal(value.ledger.npcs[0].condition, '受伤')
 assert.deepEqual(errors, [])
})
