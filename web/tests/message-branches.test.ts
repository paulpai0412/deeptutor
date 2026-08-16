import test from 'node:test'
import assert from 'node:assert/strict'
import { buildVisiblePath, nextOptimisticChildId } from '../lib/message-branches'
import type { MessageItem } from '../context/UnifiedChatContext'

test('optimistic child ids stay distinct when parent and child are created in the same millisecond', () => {
  assert.equal(nextOptimisticChildId(-1000, 1000), -1001)
})

test('a same-id reconciliation artifact does not hide the previous assistant reply', () => {
  const messages: MessageItem[] = [
    { id: 1387, role: 'user', content: '開始', parentMessageId: null },
    { id: 1388, role: 'assistant', content: '第一個回答', parentMessageId: 1387 },
    { id: 1389, role: 'user', content: '東', parentMessageId: 1388 },
    { id: 1390, role: 'assistant', content: '舊回答仍應顯示', parentMessageId: 1389 },
    { id: 1391, role: 'user', content: '西', parentMessageId: 1389 },
    { id: 1392, role: 'assistant', content: '新回答', parentMessageId: 1391 },
  ]

  const visible = buildVisiblePath(messages, { '1389': 1391 }).messages

  assert.deepEqual(
    visible.map(message => message.id),
    messages.map(message => message.id)
  )
})
