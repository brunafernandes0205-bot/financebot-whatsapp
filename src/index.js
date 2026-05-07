import express from 'express'
import twilio from 'twilio'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

const app = express()
app.use(express.urlencoded({ extended: false }))
app.use(express.json())

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

const chatHistories = new Map()

function getHistory(phone) {
  if (!chatHistories.has(phone)) chatHistories.set(phone, [])
  return chatHistories.get(phone)
}

function addToHistory(phone, role, content) {
  const history = getHistory(phone)
  history.push({ role, content })
  if (history.length > 20) history.splice(0, history.length - 20)
}

async function getBalance(phone) {
  const { data } = await supabase.from('users').select('balance').eq('phone', phone).single()
  return data?.balance ?? 0
}

async function updateBalance(phone, delta) {
  const current = await getBalance(phone)
  await supabase.from('users').upsert(
    { phone, balance: current + delta, updated_at: new Date().toISOString() },
    { onConflict: 'phone' }
  )
}

async function saveTransaction(phone, tx) {
  await supabase.from('transactions').insert({
    phone,
    description: tx.description,
    amount: tx.amount,
    category: tx.category,
    type: tx.type,
    date: new Date().toLocaleDateString('pt-BR'),
    created_at: new Date().toISOString()
  })
}

async function getTransactions(phone, limit = 10) {
  const { data } = await supabase
    .from('transactions').select('*').eq('phone', phone)
    .order('created_at', { ascending: false }).limit(limit)
  return data ?? []
}

async function buildSystemPrompt(phone) {
  const balance = await getBalance(phone)
  const transactions = await getTransactions(phone, 10)
  const expense = transactions.filter(t => t.type === 'out').reduce((s, t) => s + Number(t.amount), 0)
  const income  = transactions.filter(t => t.type === 'in').reduce((s, t) => s + Number(t.amount), 0)
  const cats = {}
  transactions.filter(t => t.type === 'out').forEach(t => { cats[t.category] = (cats[t.category] || 0) + Number(t.amount) })
  const catStr = Object.entries(cats).map(([k, v]) => `${k}: R$${v.toFixed(2)}`).join(', ') || 'nenhum gasto ainda'
  const recent = transactions.map(t => `${t.date}: ${t.type==='in'?'+':'-'}R$${t.amount} — ${t.description} (${t.category})`).join('\n') || 'nenhuma'

  return `Você é um assistente financeiro pessoal via WhatsApp. Responda SEMPRE em português brasileiro de forma curta (máximo 4 linhas).

DADOS DO USUÁRIO:
- Saldo: R$ ${Number(balance).toFixed(2)}
- Entradas: R$ ${income.toFixed(2)}
- Saídas: R$ ${expense.toFixed(2)}
- Por categoria: ${catStr}
- Últimas transações:\n${recent}

COMO REGISTRAR: quando o usuário mencionar gasto ou receita, confirme e adicione no fim:
REGISTRAR:{"description":"Nome","amount":50.00,"category":"alimentacao","type":"out"}

Categorias: alimentacao, moradia, transporte, saude, lazer, educacao, receita, outros
Para receitas use type:"in" e category:"receita"

COMANDOS: saldo, resumo, historico, ajuda — responda diretamente sem chamar IA.`
}

async function handleCommand(phone, msg) {
  const cmd = msg.trim().toLowerCase()
  if (cmd === 'saldo') {
    const b = await getBalance(phone)
    return `💰 Saldo atual: *R$ ${Number(b).toFixed(2)}*`
  }
  if (cmd === 'resumo') {
    const txs = await getTransactions(phone, 50)
    const cats = {}
    txs.filter(t => t.type === 'out').forEach(t => { cats[t.category] = (cats[t.category]||0) + Number(t.amount) })
    if (!Object.keys(cats).length) return '📊 Nenhum gasto registrado ainda.'
    const lines = Object.entries(cats).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`• ${k}: R$ ${v.toFixed(2)}`).join('\n')
    return `📊 *Gastos por categoria:*\n${lines}`
  }
  if (cmd === 'historico') {
    const txs = await getTransactions(phone, 5)
    if (!txs.length) return '📋 Nenhuma transação ainda.'
    return '📋 *Últimas transações:*\n' + txs.map(t=>`${t.type==='in'?'🟢':'🔴'} ${t.description} — R$ ${Number(t.amount).toFixed(2)}`).join('\n')
  }
  if (cmd === 'ajuda') {
    return `🤖 *FinanceBot — Comandos:*\n• *saldo* — ver saldo\n• *resumo* — gastos por categoria\n• *historico* — últimas transações\n• *ajuda* — esta mensagem\n\nOu fale natural: _"gastei R$ 50 no mercado"_`
  }
  return null
}

app.post('/webhook', async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse()
  try {
    const userMsg = req.body.Body?.trim() || ''
    const phone   = req.body.From || ''
    if (!userMsg || !phone) { res.type('text/xml').send(twiml.toString()); return }

    const cmdReply = await handleCommand(phone, userMsg)
    if (cmdReply) { twiml.message(cmdReply); res.type('text/xml').send(twiml.toString());
