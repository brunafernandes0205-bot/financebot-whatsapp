import express from 'express'
import twilio from 'twilio'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const hist = new Map()

const addHist = (p, role, content) => {
  if (!hist.has(p)) hist.set(p, [])
  const h = hist.get(p)
  h.push({ role, content })
  if (h.length > 20) h.splice(0, h.length - 20)
}

const getBal = async (p) => {
  const { data } = await db.from('users').select('balance').eq('phone', p).single()
  return Number(data?.balance ?? 0)
}

const updBal = async (p, delta) => {
  const cur = await getBal(p)
  await db.from('users').upsert({ phone: p, balance: cur + delta, updated_at: new Date().toISOString() }, { onConflict: 'phone' })
}

const saveTx = async (p, tx) => {
  await db.from('transactions').insert({ phone: p, description: tx.description, amount: tx.amount, category: tx.category, type: tx.type, date: new Date().toLocaleDateString('pt-BR'), created_at: new Date().toISOString() })
}

const getTx = async (p, limit = 10) => {
  const { data } = await db.from('transactions').select('*').eq('phone', p).order('created_at', { ascending: false }).limit(limit)
  return data ?? []
}

const buildPrompt = async (p) => {
  const bal = await getBal(p)
  const txs = await getTx(p, 10)
  const inc = txs.filter(t => t.type === 'in').reduce((s, t) => s + Number(t.amount), 0)
  const exp = txs.filter(t => t.type === 'out').reduce((s, t) => s + Number(t.amount), 0)
  const cats = {}
  txs.filter(t => t.type === 'out').forEach(t => { cats[t.category] = (cats[t.category] || 0) + Number(t.amount) })
  const catStr = Object.entries(cats).map(([k, v]) => `${k}: R$${v.toFixed(2)}`).join(', ') || 'nenhum'
  const rec = txs.map(t => `${t.date}: ${t.type === 'in' ? '+' : '-'}R$${t.amount} ${t.description}`).join('\n') || 'nenhuma'
  return `Você é um assistente financeiro via WhatsApp. Responda em português, máximo 4 linhas.
Saldo: R$${bal.toFixed(2)} | Entradas: R$${inc.toFixed(2)} | Saídas: R$${exp.toFixed(2)}
Categorias: ${catStr}
Transações:\n${rec}
Quando detectar gasto/receita, confirme e adicione no fim: REGISTRAR:{"description":"x","amount":0,"category":"alimentacao","type":"out"}
Categorias: alimentacao, moradia, transporte, saude, lazer, educacao, receita, outros`
}

const cmd = async (p, msg) => {
  const m = msg.trim().toLowerCase()
  if (m === 'saldo') return `💰 Saldo: *R$ ${(await getBal(p)).toFixed(2)}*`
  if (m === 'resumo') {
    const txs = await getTx(p, 50)
    const cats = {}
    txs.filter(t => t.type === 'out').forEach(t => { cats[t.category] = (cats[t.category] || 0) + Number(t.amount) })
    if (!Object.keys(cats).length) return '📊 Nenhum gasto ainda.'
    return '📊 *Gastos:*\n' + Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `• ${k}: R$${v.toFixed(2)}`).join('\n')
  }
  if (m === 'historico') {
    const txs = await getTx(p, 5)
    if (!txs.length) return '📋 Nenhuma transação ainda.'
    return '📋 *Últimas:*\n' + txs.map(t => `${t.type === 'in' ? '🟢' : '🔴'} ${t.description} R$${Number(t.amount).toFixed(2)}`).join('\n')
  }
  if (m === 'ajuda') return '🤖 *Comandos:*\n• saldo\n• resumo\n• historico\n• ajuda\n\nOu fale: _"gastei R$50 no mercado"_'
  return null
}

app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse()
  try {
    const msg = req.body.Body?.trim() || ''
    const phone = req.body.From || ''
    if (!msg || !phone) { res.type('text/xml').send(twiml.toString()); return }
    const cmdReply = await cmd(phone, msg)
    if (cmdReply) { twiml.message(cmdReply); res.type('text/xml').send(twiml.toString()); return }
    const system = await buildPrompt(phone)
    addHist(phone, 'user', msg)
    const resp = await ai.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 500, system, messages: hist.get(phone) })
    let reply = resp.content[0]?.text || 'Não entendi.'
    const match = reply.match(/REGISTRAR:(\{[^}]+\})/)
    if (match) {
      try {
        const tx = JSON.parse(match[1])
        await saveTx(phone, tx)
        await updBal(phone, tx.type === 'in' ? Number(tx.amount) : -Number(tx.amount))
        reply = reply.replace(/REGISTRAR:\{[^}]+\}/, '').trim()
      } catch (e) {}
    }
    addHist(phone, 'assistant', reply)
    twiml.message(reply)
  } catch (e) {
    console.error(e)
    twiml.message('❌ Erro. Tente novamente.')
  }
  res.type('text/xml').send(twiml.toString())
})

app.get('/', (req, res) => res.json({ status: 'FinanceBot online ✅' }))
app.listen(process.env.PORT || 3000, () => console.log('🚀 Bot no ar!'))
