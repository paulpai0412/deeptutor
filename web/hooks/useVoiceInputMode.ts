"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";

export const VOICE_INPUT_MODES = ["dictation", "realtime"] as const;
export type VoiceInputMode = (typeof VOICE_INPUT_MODES)[number];

const DEFAULT_MODE: VoiceInputMode = "dictation";
const GLOBAL_EVENT = "deeptutor:voice-input-mode-global";

let cachedMode: VoiceInputMode | null = null;
let inflight: Promise<VoiceInputMode> | null = null;

function normalizeMode(value: unknown): VoiceInputMode {
  return value === "realtime" ? "realtime" : DEFAULT_MODE;
}

function fetchGlobalMode(): Promise<VoiceInputMode> {
  if (cachedMode !== null) return Promise.resolve(cachedMode);
  if (!inflight) {
    inflight = apiFetch(apiUrl("/api/v1/settings"))
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        cachedMode = normalizeMode(payload?.ui?.voice_input_mode);
        return cachedMode;
      })
      .catch(() => {
        cachedMode = DEFAULT_MODE;
        return DEFAULT_MODE;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function broadcastMode(value: VoiceInputMode): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(GLOBAL_EVENT, { detail: { value } }));
}

/**
 * Global meaning of the chat composer microphone. Dictation is the safe
 * backwards-compatible default; Realtime is handled by the voice-session
 * integration when it is available.
 */
export function useVoiceInputMode() {
  const [mode, setModeState] = useState<VoiceInputMode>(
    cachedMode ?? DEFAULT_MODE,
  );
  const [loading, setLoading] = useState(cachedMode === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchGlobalMode().then((value) => {
      if (active) {
        setModeState(value);
        setLoading(false);
      }
    });

    const onGlobalMode = (event: Event) => {
      const value = (event as CustomEvent<{ value?: unknown }>).detail?.value;
      setModeState(normalizeMode(value));
    };
    window.addEventListener(GLOBAL_EVENT, onGlobalMode);
    return () => {
      active = false;
      window.removeEventListener(GLOBAL_EVENT, onGlobalMode);
    };
  }, []);

  const setMode = useCallback(async (next: VoiceInputMode) => {
    const normalized = normalizeMode(next);
    const previous = cachedMode ?? DEFAULT_MODE;
    cachedMode = normalized;
    setModeState(normalized);
    setError(null);
    broadcastMode(normalized);

    try {
      const response = await apiFetch(apiUrl("/api/v1/settings/voice-input-mode"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice_input_mode: normalized }),
      });
      if (!response.ok) {
        throw new Error(`Voice input mode update failed (HTTP ${response.status}).`);
      }
    } catch (err) {
      cachedMode = previous;
      setModeState(previous);
      broadcastMode(previous);
      setError("Could not save voice input mode.");
      throw err;
    }
  }, []);

  return { mode, setMode, loading, error };
}

export function resetVoiceInputModeCache(): void {
  cachedMode = null;
  inflight = null;
}
