import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import RealtimeVoiceSettingsPage from '../app/(utility)/settings/realtime-voice/page'
import { SETTINGS_CATEGORIES, showsSettingsToolbar, storagePathFor } from '../lib/settings-nav'

void i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initImmediate: false,
})

test('models settings exposes a dedicated Realtime Voice page', () => {
  const models = SETTINGS_CATEGORIES.find(category => category.key === 'models')
  const realtimeVoice = models?.children?.find(leaf => leaf.key === 'realtime_voice')

  assert.equal(realtimeVoice?.href, '/settings/realtime-voice')
  assert.equal(realtimeVoice?.service, undefined)
  assert.equal(storagePathFor('/settings/realtime-voice'), 'data/user/settings/realtime_voice.json')
  assert.equal(showsSettingsToolbar('/settings/realtime-voice'), false)
  assert.equal(showsSettingsToolbar('/settings/stt'), true)
})

test('models settings marks connected Realtime Voice as configured', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'components', 'settings', 'SettingsSectionGrid.tsx'),
    'utf8'
  )

  assert.match(source, /leaf\.key === "realtime_voice"/)
  assert.match(source, /realtimeVoiceStatus\.ready/)
  assert.match(source, /label: \{ zh: "已配置", en: "Configured" \}/)
})

test('Realtime Voice settings provides browser authorization and live connection actions', () => {
  const html = renderToStaticMarkup(createElement(RealtimeVoiceSettingsPage))

  assert.match(html, /data-testid="realtime-voice-authorize"/)
  assert.match(html, /data-testid="realtime-voice-test-connection"/)
  assert.doesNotMatch(html, /access_token|Bearer /i)
})
