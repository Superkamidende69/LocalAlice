// Browser regression check against a deliberately slow, page-independent server.
// Run with the bundled Playwright on NODE_PATH after npm run build.
const { chromium } = require('playwright')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../dist')
let chats = [{ id: 'browser-test', model: 'test-model', name: 'Saved stream test', history: [], tokenUsage: {}, updatedAt: 1 }]
let submissions = 0
let ticks = 0
let timer
const clone = value => JSON.parse(JSON.stringify(value))
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  if (url.pathname === '/api/chats') {
    if (req.method === 'PUT') {
      let text = ''; for await (const chunk of req) text += chunk
      const incoming = JSON.parse(text)
      chats = incoming.chats.map(chat => chats.find(c => c.id === chat.id && (c.generationStatus === 'running' || c.updatedAt > chat.updatedAt)) || chat)
    }
    return json({ chats: clone(chats), lastSaved: Date.now() })
  }
  if (url.pathname === '/api/chats/generate') {
    let text = ''; for await (const chunk of req) text += chunk
    const input = JSON.parse(text)
    submissions++
    const chat = { ...input.chat, generationId: input.id, generationStatus: 'running' }
    chats = [chat]
    const base = clone(chat.history)
    timer = setInterval(() => {
      ticks++
      chat.history = [...base, {role: 'thinking', content: 'A brief consideration.'}, {role: 'assistant', content: `Saved response token ${ticks}`}]
      chat.updatedAt = Date.now()
      if (ticks === 18) { chat.generationStatus = 'completed'; clearInterval(timer) }
    }, 350)
    return json({id: input.id}, 202)
  }
  if (url.pathname === '/api/auth/status') return json({ authEnabled: false })
  if ((!url.pathname.includes('/assets/') && url.pathname.includes('capabilities')) || url.pathname === '/v1/models') return json({data:[{id:'test-model',capabilities:['FLAG_CHAT']}]})
  if (url.pathname.includes('config-json')) return json({context_size:8192})
  if (url.pathname === '/api/features') return json({distributed:true})
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) return json({operations:[], data:[]})
  let file = path.join(root, url.pathname)
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root,'index.html')
  const type = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2'}[path.extname(file)] || 'application/octet-stream'
  res.writeHead(200, {'Content-Type':type})
  const data = fs.readFileSync(file)
  res.end(path.extname(file) === '.html' ? data.toString().replace('<head>','<head><base href="/">') : data)
})
;(async () => {
  await new Promise(resolve => server.listen(19091, '127.0.0.1', resolve))
  const browser = await chromium.launch({headless:true, ...(process.env.CHAT_TEST_CHROMIUM ? {executablePath:process.env.CHAT_TEST_CHROMIUM} : {})})
  const errors = []
  let page
  try {
    page = await browser.newPage()
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message) })
    await page.goto('http://127.0.0.1:19091/app/chat')
    await page.locator('.chat-input').fill('Test saved output')
    await page.locator('#chat-submit-btn').click()
    await page.getByRole('status').filter({hasText:'Generating on LocalAI'}).waitFor()
    await page.waitForFunction(() => document.querySelector('.chat-message-assistant .chat-message-content')?.textContent.includes('Saved response token'))
    const before = ticks
    await page.goto('http://127.0.0.1:19091/app/maps')
    await page.waitForTimeout(1100)
    assert.ok(ticks > before, 'server generation must continue away from Chat')
    await page.goto('http://127.0.0.1:19091/app/chat')
    await page.waitForFunction(() => document.querySelector('.chat-message-assistant .chat-message-content')?.textContent.includes('Saved response token'))
    await page.reload()
    await page.waitForFunction(() => document.querySelector('.chat-message-assistant .chat-message-content')?.textContent.includes('Saved response token 18'), {timeout:15000})
    assert.equal(submissions,1,'refresh must not re-submit generation')
    assert.equal(await page.locator('.chat-message-assistant .chat-message-content').count(),1,'exactly one answer bubble')
    assert.equal(await page.locator('.chat-input').isEnabled(),true,'composer unlocks on completion')
    const otherDevice = await browser.newContext()
    const second = await otherDevice.newPage()
    await second.goto('http://127.0.0.1:19091/app/chat')
    await second.waitForFunction(() => document.querySelector('.chat-message-assistant .chat-message-content')?.textContent.includes('Saved response token 18'))
    assert.equal(errors.length,0,errors.join('\n'))
    console.log('PASS: navigate away, return, refresh mid-generation, complete once, second-device recovery, no duplicate bubble, no React errors')
  } catch (error) {
    console.error('Diagnostic:', JSON.stringify({submissions,ticks,chats,errors}))
    console.error('Page:', await page?.locator('body').innerText())
    throw error
  } finally {
    clearInterval(timer)
    await browser.close()
    server.close()
  }
})().catch(error => {console.error(error);process.exitCode=1;server.close()})
