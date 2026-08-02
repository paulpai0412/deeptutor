import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { ambientAnimationFor } from '../lib/ambient-pet'

function readSource(...segments: string[]) {
  return fs.readFileSync(path.join(process.cwd(), ...segments), 'utf8')
}

test('ambient mapping: idle when nothing has run', () => {
  assert.equal(
    ambientAnimationFor({ pendingAskUser: false, isStreaming: false, status: 'idle' }),
    'idle'
  )
  assert.equal(
    ambientAnimationFor({ pendingAskUser: false, isStreaming: false, status: null }),
    'idle'
  )
})

test('ambient mapping: streaming turn maps to running (codex Thinking)', () => {
  assert.equal(
    ambientAnimationFor({ pendingAskUser: false, isStreaming: true, status: 'running' }),
    'running'
  )
  // Status alone also covers background/rehydrated running sessions.
  assert.equal(
    ambientAnimationFor({ pendingAskUser: false, isStreaming: false, status: 'running' }),
    'running'
  )
})

test('ambient mapping: pending ask_user maps to waiting (codex Needs input)', () => {
  // Waiting wins over a still-marked-running session: the turn is paused on
  // the user, so that is the honest signal.
  assert.equal(
    ambientAnimationFor({ pendingAskUser: true, isStreaming: true, status: 'running' }),
    'waiting'
  )
  assert.equal(
    ambientAnimationFor({ pendingAskUser: true, isStreaming: false, status: 'idle' }),
    'waiting'
  )
})

test('ambient mapping: terminal non-success statuses map to failed (codex Blocked)', () => {
  for (const status of ['failed', 'cancelled', 'rejected']) {
    assert.equal(
      ambientAnimationFor({ pendingAskUser: false, isStreaming: false, status }),
      'failed',
      status
    )
  }
})

test('ambient mapping: completed turn maps to review and lingers (codex Ready)', () => {
  assert.equal(
    ambientAnimationFor({ pendingAskUser: false, isStreaming: false, status: 'completed' }),
    'review'
  )
  // A new turn starting overrides the lingering review pose.
  assert.equal(
    ambientAnimationFor({ pendingAskUser: false, isStreaming: true, status: 'completed' }),
    'running'
  )
})

test('ambient component: hidden when disabled, static under reduced motion, click-through', () => {
  const source = readSource('components', 'pets', 'AmbientPet.tsx')
  assert.match(source, /getPet\(pet\)/, 'resolves the AppShell pet preference')
  assert.match(
    source,
    /if \(!definition \|\| voiceSessionActive\) return null;?/,
    'disabled/unknown renders nothing (and yields during voice sessions)'
  )
  assert.match(source, /pointer-events-none/, 'never intercepts clicks')
  assert.match(source, /usePrefersReducedMotion/, 'honors reduced motion')
  assert.match(source, /animate=\{!reducedMotion\}/, 'reduced motion shows a static frame')
  assert.match(source, /aria-hidden/, 'decorative overlay stays out of the a11y tree')
  assert.match(source, /hasPendingAskUserInMessages/, 'waiting state wired to ask_user cards')
})

test('ambient component: mounted in the workspace layout inside UnifiedChatProvider', () => {
  const source = readSource('app', '(workspace)', 'layout.tsx')
  assert.match(source, /import \{ AmbientPet \} from "@\/components\/pets\/AmbientPet";/)
  const providerIndex = source.indexOf('<UnifiedChatProvider>')
  const mountIndex = source.indexOf('<AmbientPet />')
  const closeIndex = source.indexOf('</UnifiedChatProvider>')
  assert.ok(providerIndex !== -1 && mountIndex !== -1 && closeIndex !== -1)
  assert.ok(
    providerIndex < mountIndex && mountIndex < closeIndex,
    'AmbientPet must mount inside UnifiedChatProvider (it reads useUnifiedChat)'
  )
})

test('chat state: selected session status is exposed for the ambient mapping', () => {
  const source = readSource('context', 'UnifiedChatContext.tsx')
  assert.match(
    source,
    /export interface ChatState \{[\s\S]*?status: SessionRuntimeStatus;/,
    'ChatState carries the session runtime status'
  )
  assert.match(
    source,
    /status: current\.status,/,
    "derivedState forwards the selected session's status"
  )
})
