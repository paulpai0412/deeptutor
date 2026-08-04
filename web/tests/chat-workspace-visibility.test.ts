import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { AssistantActivity } from '../components/chat/home/TracePanels'
import type { StreamEvent } from '../lib/unified-ws'

void i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initImmediate: false,
})

const traceEvent: StreamEvent = {
  type: 'thinking',
  source: 'chat',
  stage: 'responding',
  content: 'Visible workspace reasoning',
  metadata: { call_id: 'voice-turn-1', call_kind: 'agent_loop_round' },
  timestamp: 0,
}

test('completed assistant activity remains expanded by default', () => {
  const html = renderToStaticMarkup(
    createElement(AssistantActivity, {
      events: [traceEvent],
      isStreaming: false,
      content: 'Canonical answer',
    })
  )

  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /grid-rows-\[1fr\] opacity-100/)
  assert.doesNotMatch(html, /grid-rows-\[0fr\] opacity-0/)
})
