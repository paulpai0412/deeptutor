/**
 * Maps realtime voice session state to a pet animation track, so the
 * selected pet can act as the voice session's on-screen avatar — the Codex
 * GPT-Live "avatar overlay = Pet" behavior (see
 * docs/research/codex-pet-voice-integration.md).
 */

import type { RealtimeVoiceSessionState } from "@/hooks/useRealtimeVoiceSession";

export function voicePetAnimationFor(state: RealtimeVoiceSessionState): string {
  switch (state) {
    // Working on the session (codex "Running").
    case "connecting":
    case "ending":
      return "running";
    // Waiting for the user to speak (codex "Needs input").
    case "listening":
      return "waiting";
    // Assistant is talking — lively motion (codex has no dedicated track).
    case "speaking":
      return "jumping";
    // Interrupted: acknowledge the cut-off with a wave.
    case "interrupted":
      return "waving";
    // Session failure (codex "Blocked").
    case "error":
      return "failed";
    // Muted / idle: plain standby.
    case "muted":
    case "idle":
    default:
      return "idle";
  }
}
