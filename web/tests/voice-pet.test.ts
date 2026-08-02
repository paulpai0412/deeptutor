import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import RealtimeVoiceControl from '../components/chat/home/RealtimeVoiceControl'
import { AppShellProvider } from '../context/AppShellContext'
import {
  getRealtimeVoiceActive,
  setRealtimeVoiceActive,
  subscribeRealtimeVoiceActive,
} from '../lib/realtime-voice-activity'
import { voicePetAnimationFor } from '../lib/voice-pet'

void i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: {} } },
  initImmediate: false,
})

const noop = () => {}

function renderBubble(state: string, transcript = 'A full sentence from the mic.') {
  return renderToStaticMarkup(
    createElement(
      AppShellProvider,
      null,
      createElement(RealtimeVoiceControl, {
        state: state as never,
        transcript,
        error: null,
        audioOutputReceived: state === 'speaking',
        audioOutputCount: state === 'speaking' ? 1 : 0,
        lastTurnMode: null,
        disabled: false,
        onToggle: noop,
        onToggleMute: noop,
        onInterrupt: noop,
        onEnd: noop,
      })
    )
  )
}

function readSource(...segments: string[]) {
  return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8')
}

test('voice pet mapping: every session state maps to the codex-faithful track', () => {
  // Working states (codex Running).
  assert.equal(voicePetAnimationFor('connecting'), 'running')
  assert.equal(voicePetAnimationFor('ending'), 'running')
  // Waiting for the user to speak (codex Needs input).
  assert.equal(voicePetAnimationFor('listening'), 'waiting')
  // Assistant talking / interrupted acknowledgement.
  assert.equal(voicePetAnimationFor('speaking'), 'jumping')
  assert.equal(voicePetAnimationFor('interrupted'), 'waving')
  // Failure (codex Blocked).
  assert.equal(voicePetAnimationFor('error'), 'failed')
  // Standby states.
  assert.equal(voicePetAnimationFor('muted'), 'idle')
  assert.equal(voicePetAnimationFor('idle'), 'idle')
})

test('bubble: shows the selected pet as session avatar with a transcript callout', () => {
  const markup = renderBubble('listening')
  // AppShell SSR default pet is codex → avatar visible.
  assert.match(markup, /data-testid="realtime-pet-avatar"/)
  assert.match(markup, /data-testid="realtime-pet-callout"/)
  // The sentence transcript keeps its original test id inside the callout.
  assert.match(markup, /data-testid="realtime-partial-transcript"/)
  assert.match(markup, /A full sentence from the mic\./)
})

test('bubble: callout hides when the transcript is empty', () => {
  const markup = renderBubble('listening', '')
  assert.match(markup, /data-testid="realtime-pet-avatar"/)
  assert.doesNotMatch(markup, /data-testid="realtime-pet-callout"/)
  assert.match(markup, /Speak naturally\. Your sentence will appear here\./)
})

test('bubble: tapping the pet toggles the control strip', () => {
  const source = readSource('components', 'chat', 'home', 'RealtimeVoiceControl.tsx')
  assert.match(source, /setControlsOpen\(\(value\) => !value\)/)
  assert.match(source, /aria-expanded=\{controlsOpen\}/)
  assert.match(source, /petDefinition && !controlsOpen \? null :/)
  // Default is expanded.
  assert.match(source, /useState\(true\)/)
})

test('bubble: without a pet the control strip always shows and no avatar renders', () => {
  const source = readSource('components', 'chat', 'home', 'RealtimeVoiceControl.tsx')
  // disabled preference → getPet returns null → plain layout branch.
  assert.match(source, /const petDefinition = getPet\(pet\);/)
  assert.match(source, /\{petDefinition \? \(/)
})

test('voice activity signal: store round-trip and unmount-safe default', () => {
  assert.equal(getRealtimeVoiceActive(), false)
  let notified = 0
  const unsubscribe = subscribeRealtimeVoiceActive(() => {
    notified += 1
  })
  setRealtimeVoiceActive(true)
  assert.equal(getRealtimeVoiceActive(), true)
  setRealtimeVoiceActive(true) // no-op: same value
  setRealtimeVoiceActive(false)
  assert.equal(getRealtimeVoiceActive(), false)
  assert.equal(notified, 2)
  unsubscribe()
})

test('ambient pet yields the stage while a voice session is live', () => {
  const ambient = readSource('components', 'pets', 'AmbientPet.tsx')
  assert.match(ambient, /subscribeRealtimeVoiceActive/)
  assert.match(ambient, /if \(!definition \|\| voiceSessionActive\) return null;?/)

  const hook = readSource('hooks', 'useRealtimeVoiceSession.ts')
  assert.match(hook, /setRealtimeVoiceActive\(state !== "idle"\)/)
  // Liveness resets when the hook unmounts.
  assert.match(hook, /return \(\) => setRealtimeVoiceActive\(false\);/)
})

test('reduced motion: bubble avatar falls back to a still frame', () => {
  const source = readSource('components', 'chat', 'home', 'RealtimeVoiceControl.tsx')
  assert.match(source, /usePrefersReducedMotion/)
  assert.match(source, /animate=\{!reducedMotion\}/)
})

test('i18n: the pet control-toggle label exists in all three locales', () => {
  for (const locale of ['en', 'zh', 'zh-TW']) {
    const messages = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'locales', locale, 'app.json'), 'utf8')
    ) as Record<string, string>
    assert.ok(messages['Toggle voice controls'], `missing Toggle voice controls in ${locale}`)
  }
})
