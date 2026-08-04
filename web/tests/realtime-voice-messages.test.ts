import test from 'node:test'
import assert from 'node:assert/strict'

import type { MessageItem } from '../context/UnifiedChatContext'
import { mergeRealtimeVoiceAssistant } from '../lib/realtime-voice'

const messages: MessageItem[] = [
  { id: 1, role: 'user' as const, content: 'Question', parentMessageId: null },
  {
    id: 2,
    role: 'assistant' as const,
    content: 'DeepTutor draft',
    parentMessageId: 1,
    events: [
      {
        type: 'done',
        source: 'test',
        stage: '',
        content: '',
        metadata: {},
        timestamp: 0,
      },
    ],
  },
]

test('direct GPT-Live speech appends one visible assistant message', () => {
  const merged = mergeRealtimeVoiceAssistant(messages, {}, {
    text: 'Direct spoken answer',
    final: true,
    turnId: 'provider-assistant-1',
    delegated: false,
    revision: 1,
  })

  assert.equal(merged.length, 3)
  assert.deepEqual(merged[2], {
    id: -1,
    role: 'assistant',
    content: 'Direct spoken answer',
    capability: 'realtime_voice',
    parentMessageId: 2,
    providerTurnId: 'provider-assistant-1',
  })
})

test('duplicate provider assistant finals update one message in place', () => {
  const first = mergeRealtimeVoiceAssistant(messages, {}, {
    text: 'Direct spoken answer',
    final: true,
    turnId: 'provider-assistant-1',
    delegated: false,
    revision: 1,
  })
  const duplicate = mergeRealtimeVoiceAssistant(first, {}, {
    text: 'Direct spoken answer',
    final: true,
    turnId: 'provider-assistant-1',
    delegated: false,
    revision: 2,
  })

  assert.equal(duplicate.length, first.length)
  assert.equal(duplicate[2].content, 'Direct spoken answer')
})

test('committed direct GPT-Live turns keep chronological history', () => {
  const first = mergeRealtimeVoiceAssistant(
    messages,
    {},
    {
      text: 'First direct answer',
      final: true,
      turnId: 'provider-assistant-1',
      delegated: false,
      revision: 1,
    },
    -10
  )
  const second = mergeRealtimeVoiceAssistant(
    first,
    {},
    {
      text: 'Second direct answer',
      final: true,
      turnId: 'provider-assistant-2',
      delegated: false,
      revision: 1,
    },
    -11
  )

  assert.deepEqual(
    second.slice(-2).map(message => message.content),
    ['First direct answer', 'Second direct answer']
  )
  assert.equal(second[3].parentMessageId, -10)
})

test('delegated GPT-Live speech replaces the visible DeepTutor text without duplicating activity', () => {
  const merged = mergeRealtimeVoiceAssistant(messages, {}, {
    text: 'Final spoken answer',
    final: true,
    turnId: 'provider-assistant-2',
    delegated: true,
    revision: 1,
  })

  assert.equal(merged.length, 2)
  assert.equal(merged[1].content, 'Final spoken answer')
  assert.equal(merged[1].events, messages[1].events)
})

test('empty GPT-Live transcript leaves persisted messages untouched', () => {
  assert.equal(
    mergeRealtimeVoiceAssistant(messages, {}, {
      text: '',
      final: false,
      turnId: '',
      delegated: false,
      revision: 0,
    }),
    messages,
  )
})
