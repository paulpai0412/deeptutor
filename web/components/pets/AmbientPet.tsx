'use client'

import { useMemo, useSyncExternalStore } from 'react'

import { useAppShell } from '@/context/AppShellContext'
import { useUnifiedChat } from '@/context/UnifiedChatContext'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { ambientAnimationFor } from '@/lib/ambient-pet'
import { hasPendingAskUserInMessages } from '@/lib/ask-user-state'
import {
  petGrowthAppearance,
  readPetGrowth,
  readPetGrowthServer,
  subscribePetGrowth,
} from '@/lib/pet-growth'
import { getPet } from '@/lib/pets'
import {
  getRealtimeVoiceActive,
  getRealtimeVoiceActiveServer,
  subscribeRealtimeVoiceActive,
} from '@/lib/realtime-voice-activity'

import { PetSprite } from './PetSprite'

/**
 * Ambient companion overlay for the workspace, ported from the Codex CLI
 * ambient pet: the selected pet lives in the corner above the composer and
 * reacts to the live turn — running while streaming, waiting on ask_user,
 * sad when a turn fails, and a ready pose once a turn completes.
 *
 * Hidden when the pet preference is "disabled" and on small screens; static
 * first frame under prefers-reduced-motion. Never intercepts pointer events.
 */
export function AmbientPet() {
  const { pet } = useAppShell()
  const { state } = useUnifiedChat()
  const reducedMotion = usePrefersReducedMotion()
  // While a realtime voice session is live, the pet acts as the session
  // avatar inside the voice bubble — the ambient copy yields the stage.
  const voiceSessionActive = useSyncExternalStore(
    subscribeRealtimeVoiceActive,
    getRealtimeVoiceActive,
    getRealtimeVoiceActiveServer
  )

  const pendingAskUser = useMemo(
    () => hasPendingAskUserInMessages(state.messages),
    [state.messages]
  )
  const growth = useSyncExternalStore(subscribePetGrowth, readPetGrowth, readPetGrowthServer)
  const appearance = useMemo(() => petGrowthAppearance(growth.xp), [growth.xp])

  const definition = getPet(pet)
  if (!definition || voiceSessionActive) return null

  const animation = ambientAnimationFor({
    pendingAskUser,
    isStreaming: state.isStreaming,
    status: state.status,
  })

  return (
    <div className="pointer-events-none fixed bottom-28 right-6 z-30 hidden md:block" aria-hidden>
      <div className="relative">
        <span className="absolute -right-1 -top-2 text-[18px] drop-shadow-sm" aria-hidden>
          {appearance.badge}
        </span>
        <PetSprite
          pet={definition}
          animation={animation}
          animate={!reducedMotion}
          height={Math.round(appearance.height * 0.57)}
        />
      </div>
    </div>
  )
}

export default AmbientPet
