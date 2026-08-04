/**
 * Tiny cross-tree signal for "a realtime voice session is live right now".
 *
 * The voice session hook owns session state inside the composer subtree, but
 * the workspace-level AmbientPet (a different provider branch) needs to know
 * so it can yield the stage to the in-bubble pet avatar instead of showing a
 * second pet. Boolean last-write-wins is sufficient: only one voice session
 * can be live at a time.
 */

let active = false
const listeners = new Set<() => void>()

export type RealtimeVoiceAssistantSnapshot = {
  text: string
  final: boolean
  turnId: string
  delegated: boolean
  revision: number
}

const emptyAssistant: RealtimeVoiceAssistantSnapshot = {
  text: '',
  final: false,
  turnId: '',
  delegated: false,
  revision: 0,
}
let assistant = emptyAssistant
const assistantListeners = new Set<() => void>()

export function setRealtimeVoiceActive(next: boolean): void {
  if (active === next) return
  active = next
  for (const listener of listeners) listener()
}

export function subscribeRealtimeVoiceActive(callback: () => void): () => void {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

export function getRealtimeVoiceActive(): boolean {
  return active
}

export function getRealtimeVoiceActiveServer(): boolean {
  return false
}

export function setRealtimeVoiceAssistant(
  text: string,
  final: boolean,
  turnId: string,
  delegated = false
): void {
  const next = text
    ? { text, final, turnId, delegated, revision: assistant.revision + 1 }
    : emptyAssistant
  if (
    next.text === assistant.text &&
    next.final === assistant.final &&
    next.turnId === assistant.turnId &&
    next.delegated === assistant.delegated
  ) {
    return
  }
  assistant = next
  for (const listener of assistantListeners) listener()
}

export function subscribeRealtimeVoiceAssistant(callback: () => void): () => void {
  assistantListeners.add(callback)
  return () => {
    assistantListeners.delete(callback)
  }
}

export function getRealtimeVoiceAssistant(): RealtimeVoiceAssistantSnapshot {
  return assistant
}

export function getRealtimeVoiceAssistantServer(): RealtimeVoiceAssistantSnapshot {
  return emptyAssistant
}
