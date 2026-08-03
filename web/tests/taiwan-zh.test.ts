import assert from 'node:assert/strict'
import test from 'node:test'

import { selectLocalizedText } from '@/i18n/localized-text'
import zhTwApp from '@/locales/zh-TW/app.json'

test('language selection keeps Simplified and Traditional resources distinct', () => {
  const text = { en: 'Settings', zh: '设置', zhTW: '設定' }
  assert.equal(selectLocalizedText('zh', text), '设置')
  assert.equal(selectLocalizedText('zh-TW', text), '設定')
})

test('Traditional Chinese locale defaults use Taiwan wording', () => {
  assert.equal(zhTwApp['Upload failed'], '上傳失敗')
  assert.equal(
    zhTwApp['No knowledge bases found. Create one to get started.'],
    '未找到任何知識庫。請先建立一個。'
  )
})
