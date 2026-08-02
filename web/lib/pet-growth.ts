export const PET_GROWTH_STORAGE_KEY = 'deeptutor.petGrowth'
export const PET_GROWTH_EVENT = 'deeptutor:pet-growth'

export type PetGrowthEventKind =
  'quiz_correct' | 'quiz_wrong' | 'quiz_practice' | 'mission' | 'manual'

export type PetGrowthRecent = {
  id: string
  label: string
  xp: number
  at: string
}

export type PetGrowthState = {
  xp: number
  streak: number
  lastStudyDay: string | null
  claimedMissions: Record<string, string[]>
  recent: PetGrowthRecent[]
}

export const PET_MISSIONS = [
  { id: 'focus', labelZh: '完成 10 分鐘專心學習', labelEn: 'Finish 10 minutes of focus', xp: 15 },
  { id: 'practice', labelZh: '回答一題練習題', labelEn: 'Answer one practice question', xp: 8 },
  { id: 'mistake', labelZh: '整理一題錯題', labelEn: 'Review one mistake', xp: 12 },
] as const

const DEFAULT_STATE: PetGrowthState = {
  xp: 0,
  streak: 0,
  lastStudyDay: null,
  claimedMissions: {},
  recent: [],
}

function todayKey(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  const start = Date.parse(`${a}T00:00:00`)
  const end = Date.parse(`${b}T00:00:00`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.round((end - start) / 86_400_000)
}

function sanitizeState(value: unknown): PetGrowthState {
  if (!value || typeof value !== 'object') return DEFAULT_STATE
  const raw = value as Partial<PetGrowthState>
  const claimedMissions =
    raw.claimedMissions && typeof raw.claimedMissions === 'object' ? raw.claimedMissions : {}
  return {
    xp: Math.max(0, Number(raw.xp) || 0),
    streak: Math.max(0, Number(raw.streak) || 0),
    lastStudyDay: typeof raw.lastStudyDay === 'string' ? raw.lastStudyDay : null,
    claimedMissions,
    recent: Array.isArray(raw.recent)
      ? raw.recent
          .filter(
            item =>
              item &&
              typeof item.id === 'string' &&
              typeof item.label === 'string' &&
              typeof item.at === 'string'
          )
          .slice(0, 8)
          .map(item => ({
            id: item.id,
            label: item.label,
            xp: Number(item.xp) || 0,
            at: item.at,
          }))
      : [],
  }
}

let cachedRaw: string | null = null
let cachedState: PetGrowthState = DEFAULT_STATE

export function readPetGrowth(): PetGrowthState {
  if (typeof window === 'undefined') return DEFAULT_STATE
  try {
    const raw = window.localStorage.getItem(PET_GROWTH_STORAGE_KEY)
    if (raw === cachedRaw) return cachedState
    cachedRaw = raw
    cachedState = sanitizeState(JSON.parse(raw || 'null'))
    return cachedState
  } catch {
    return DEFAULT_STATE
  }
}

export function readPetGrowthServer(): PetGrowthState {
  return DEFAULT_STATE
}

export function subscribePetGrowth(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const onStorage = (event: StorageEvent) => {
    if (event.key === PET_GROWTH_STORAGE_KEY) callback()
  }
  window.addEventListener(PET_GROWTH_EVENT, callback)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PET_GROWTH_EVENT, callback)
    window.removeEventListener('storage', onStorage)
  }
}

function writePetGrowth(state: PetGrowthState): void {
  if (typeof window === 'undefined') return
  try {
    const raw = JSON.stringify(state)
    cachedRaw = raw
    cachedState = state
    window.localStorage.setItem(PET_GROWTH_STORAGE_KEY, raw)
    window.dispatchEvent(new CustomEvent(PET_GROWTH_EVENT, { detail: state }))
  } catch {
    // localStorage may be unavailable.
  }
}

function addRecent(state: PetGrowthState, label: string, xp: number, at: string): PetGrowthState {
  return {
    ...state,
    xp: Math.max(0, state.xp + xp),
    recent: [{ id: `${at}:${label}`, label, xp, at }, ...state.recent].slice(0, 8),
  }
}

function applyStudyDay(state: PetGrowthState, at: string): PetGrowthState {
  const today = todayKey(new Date(at))
  if (state.lastStudyDay === today) return state

  let next = state
  if (state.lastStudyDay) {
    const gap = daysBetween(state.lastStudyDay, today)
    if (gap > 1) {
      const missed = gap - 1
      next = addRecent(
        next,
        `Missed ${missed} study day${missed > 1 ? 's' : ''}`,
        -Math.min(30, missed * 5),
        at
      )
    }
    next = { ...next, streak: gap === 1 ? next.streak + 1 : 1 }
  } else {
    next = { ...next, streak: 1 }
  }

  next = { ...next, lastStudyDay: today }
  return addRecent(next, 'Study Day check-in', 10, at)
}

export function recordPetLearningEvent(input: {
  kind: PetGrowthEventKind
  label: string
  xp: number
  countsAsStudyDay?: boolean
}): PetGrowthState {
  const at = new Date().toISOString()
  let next = readPetGrowth()
  if (input.countsAsStudyDay !== false) {
    next = applyStudyDay(next, at)
  }
  next = addRecent(next, input.label, input.xp, at)
  writePetGrowth(next)
  return next
}

export function claimPetMission(mission: { id: string; label: string; xp: number }): {
  state: PetGrowthState
  claimed: boolean
} {
  const at = new Date().toISOString()
  const today = todayKey(new Date(at))
  let state = readPetGrowth()
  const todaysClaims = state.claimedMissions[today] ?? []
  if (todaysClaims.includes(mission.id)) return { state, claimed: false }

  state = applyStudyDay(state, at)
  state = addRecent(state, mission.label, mission.xp, at)
  state = {
    ...state,
    claimedMissions: {
      ...state.claimedMissions,
      [today]: [...todaysClaims, mission.id],
    },
  }
  writePetGrowth(state)
  return { state, claimed: true }
}

export function resetPetGrowth(): PetGrowthState {
  writePetGrowth(DEFAULT_STATE)
  return DEFAULT_STATE
}

export function petLevel(xp: number): number {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 80)) + 1
}

export function petLevelProgress(xp: number): {
  level: number
  current: number
  needed: number
  ratio: number
} {
  const level = petLevel(xp)
  const start = (level - 1) ** 2 * 80
  const next = level ** 2 * 80
  const current = Math.max(0, xp - start)
  const needed = next - start
  return { level, current, needed, ratio: Math.min(1, current / needed) }
}

export type PetGrowthAppearance = {
  stage: 'baby' | 'sprout' | 'star' | 'legend'
  labelZh: string
  labelEn: string
  height: number
  auraClassName: string
  badge: string
}

export function petGrowthAppearance(xp: number): PetGrowthAppearance {
  const level = petLevel(xp)
  if (level >= 5) {
    return {
      stage: 'legend',
      labelZh: '傳奇學霸',
      labelEn: 'Legend scholar',
      height: 150,
      auraClassName:
        'from-violet-200 via-amber-100 to-fuchsia-200 dark:from-violet-950/50 dark:via-amber-950/30 dark:to-fuchsia-950/40',
      badge: '👑',
    }
  }
  if (level >= 3) {
    return {
      stage: 'star',
      labelZh: '閃耀成長',
      labelEn: 'Shining growth',
      height: 140,
      auraClassName:
        'from-amber-200 via-orange-100 to-sky-200 dark:from-amber-950/50 dark:via-orange-950/30 dark:to-sky-950/40',
      badge: '⭐',
    }
  }
  if (level >= 2) {
    return {
      stage: 'sprout',
      labelZh: '努力長大',
      labelEn: 'Growing learner',
      height: 126,
      auraClassName:
        'from-emerald-100 via-lime-50 to-sky-100 dark:from-emerald-950/40 dark:via-lime-950/20 dark:to-sky-950/30',
      badge: '🌱',
    }
  }
  return {
    stage: 'baby',
    labelZh: '新手幼崽',
    labelEn: 'Baby buddy',
    height: 112,
    auraClassName:
      'from-slate-100 via-amber-50 to-sky-100 dark:from-slate-900/50 dark:via-amber-950/20 dark:to-sky-950/30',
    badge: '🐾',
  }
}

export function petBadges(state: PetGrowthState): string[] {
  return [
    state.xp >= 80 ? 'First level up' : '',
    state.streak >= 3 ? '3-day streak' : '',
    state.xp >= 500 ? '500 XP scholar' : '',
  ].filter(Boolean)
}

export function claimedMissionIdsToday(state: PetGrowthState): string[] {
  return state.claimedMissions[todayKey()] ?? []
}
