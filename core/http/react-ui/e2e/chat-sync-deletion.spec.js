// SPDX-License-Identifier: MIT
import { test, expect } from './coverage-fixtures.js'

function chat(id) {
  return {
    id, name: `Conversation ${id}`, model: 'test-model',
    history: [{ role: 'user', content: `Question ${id}` }],
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    createdAt: 1, updatedAt: 1,
  }
}

async function setup(page) {
  await page.route('**/api/**', route => route.fulfill({ json: {
    authEnabled: false, operations: [],
    data: [{ id: 'test-model', capabilities: ['FLAG_CHAT'] }],
  } }))
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  const state = { chats: [chat('a'), chat('b')], deletedChatIds: [], offline: false, puts: [], gets: 0 }
  await page.addInitScript(chats => {
    if (!localStorage.getItem('localai_chats_data')) {
      localStorage.setItem('localai_chats_data', JSON.stringify({ chats, activeChatId: 'a' }))
    }
  }, state.chats)
  await page.route('**/api/chats', async route => {
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON()
      state.puts.push(payload)
      if (state.offline) return route.fulfill({ status: 503, json: {} })
      state.deletedChatIds = [...new Set([...state.deletedChatIds, ...payload.deletedChatIds])]
      state.chats = payload.chats.filter(item => !state.deletedChatIds.includes(item.id))
    } else {
      state.gets++
    }
    await route.fulfill({ json: { chats: state.chats, deletedChatIds: state.deletedChatIds } })
  })
  await page.goto('/app/chat')
  await expect(page.locator('.chat-message-user')).toContainText('Question a')
  return state
}

test('an offline deletion is retried after reload with explicit IDs', async ({ page }) => {
  const state = await setup(page)
  state.offline = true
  await page.locator('.chats-menu-trigger').click()
  await page.locator('.chats-menu-item').filter({ hasText: 'Conversation b' }).locator('.chats-menu-item-delete').click()
  await expect.poll(() => state.puts.some(payload => payload.deletedChatIds.includes('b'))).toBe(true)
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('localai_chats_data')).deletedChatIds)).toEqual(['b'])

  state.offline = false
  await page.reload()
  await expect.poll(() => state.deletedChatIds).toContain('b')
  await page.locator('.chats-menu-trigger').click()
  await expect(page.locator('.chats-menu-item')).toHaveCount(1)
  await expect(page.locator('.chats-menu-item')).toContainText('Conversation a')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('localai_chats_data')).deletedChatIds)).toEqual([])
})

test('a remote clear removes local history and keeps the empty chat stable across polls', async ({ page }) => {
  const state = await setup(page)
  state.chats = []
  state.deletedChatIds = ['a', 'b']
  await expect(page.locator('.chat-message-user')).toHaveCount(0)
  const activeID = await page.evaluate(() => JSON.parse(localStorage.getItem('localai_chats_data')).chats[0].id)
  const gets = state.gets
  await expect.poll(() => state.gets).toBeGreaterThan(gets + 2)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('localai_chats_data')).chats[0].id)).toBe(activeID)
})
