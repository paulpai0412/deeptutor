import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PET_GROWTH_STORAGE_KEY,
  claimPetMission,
  petGrowthAppearance,
  petLevelProgress,
  readPetGrowth,
  recordPetLearningEvent,
  resetPetGrowth,
} from '../lib/pet-growth'

type Listener = (event: Event) => void

function installWindowStub() {
  const store = new Map<string, string>()
  const listeners = new Map<string, Set<Listener>>()

  class TestCustomEvent<T = unknown> extends Event {
    detail: T
    constructor(type: string, init?: CustomEventInit<T>) {
      super(type)
      this.detail = init?.detail as T
    }
  }

  Object.defineProperty(globalThis, 'CustomEvent', {
    value: TestCustomEvent,
    configurable: true,
  })
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
      addEventListener: (type: string, listener: Listener) => {
        const set = listeners.get(type) ?? new Set<Listener>()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener: (type: string, listener: Listener) => {
        listeners.get(type)?.delete(listener)
      },
      dispatchEvent: (event: Event) => {
        listeners.get(event.type)?.forEach(listener => listener(event))
        return true
      },
    },
    configurable: true,
  })

  return store
}

test('pet growth: quiz events add Study Day XP and answer XP', () => {
  const store = installWindowStub()
  resetPetGrowth()

  const state = recordPetLearningEvent({
    kind: 'quiz_correct',
    label: 'Correct quiz answer',
    xp: 12,
  })

  assert.equal(state.xp, 22)
  assert.equal(state.streak, 1)
  assert.equal(state.recent[0].label, 'Correct quiz answer')
  assert.ok(store.get(PET_GROWTH_STORAGE_KEY))
})

test('pet growth: daily missions can only be claimed once', () => {
  installWindowStub()
  resetPetGrowth()

  const first = claimPetMission({ id: 'focus', label: 'Focus', xp: 15 })
  const second = claimPetMission({ id: 'focus', label: 'Focus', xp: 15 })

  assert.equal(first.claimed, true)
  assert.equal(second.claimed, false)
  assert.equal(readPetGrowth().xp, 25)
})

test('pet growth: level progress uses rising XP thresholds', () => {
  assert.deepEqual(petLevelProgress(0), {
    level: 1,
    current: 0,
    needed: 80,
    ratio: 0,
  })
  assert.equal(petLevelProgress(80).level, 2)
  assert.equal(petLevelProgress(320).level, 3)
})

test('pet growth: appearance changes with XP level', () => {
  assert.equal(petGrowthAppearance(0).stage, 'baby')
  assert.equal(petGrowthAppearance(80).stage, 'sprout')
  assert.equal(petGrowthAppearance(320).stage, 'star')
  assert.equal(petGrowthAppearance(1280).stage, 'legend')
  assert.ok(petGrowthAppearance(1280).height > petGrowthAppearance(0).height)
})
