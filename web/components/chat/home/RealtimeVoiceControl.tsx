"use client";

import {
  AudioWaveform,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  Square,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { PetSprite } from "@/components/pets/PetSprite";
import { useAppShell } from "@/context/AppShellContext";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { RealtimeVoiceSessionState } from "@/hooks/useRealtimeVoiceSession";
import { getPet } from "@/lib/pets";
import { voicePetAnimationFor } from "@/lib/voice-pet";

type Props = {
  state: RealtimeVoiceSessionState;
  transcript: string;
  error: string | null;
  audioOutputReceived: boolean;
  audioOutputCount: number;
  lastTurnMode: "delegated" | "provider" | null;
  disabled: boolean;
  onToggle: () => void;
  onToggleMute: () => void;
  onInterrupt: () => void;
  onEnd: () => void;
};

function VoicePulse({ active }: { active: boolean }) {
  return (
    <span className="flex h-4 items-center gap-[2px]" aria-hidden>
      {[7, 13, 9, 15, 8].map((height, index) => (
        <span
          key={`${height}-${index}`}
          className={`w-[2px] rounded-full bg-current ${active ? "animate-pulse" : ""}`}
          style={{
            height,
            animationDelay: `${index * 90}ms`,
            animationDuration: "720ms",
          }}
        />
      ))}
    </span>
  );
}

export default function RealtimeVoiceControl({
  state,
  transcript,
  error,
  audioOutputReceived,
  audioOutputCount,
  lastTurnMode,
  disabled,
  onToggle,
  onToggleMute,
  onInterrupt,
  onEnd,
}: Props) {
  const { t } = useTranslation();
  const { pet } = useAppShell();
  const petDefinition = getPet(pet);
  const reducedMotion = usePrefersReducedMotion();
  // The pet is the session's on-screen avatar (codex "avatar overlay = Pet");
  // tapping it shows/hides the control strip, mirroring how tapping the codex
  // pet returns focus to its chat.
  const [controlsOpen, setControlsOpen] = useState(true);
  const open = state !== "idle" || Boolean(error);
  const sessionActive = state !== "idle" && state !== "error";
  const listening = state === "listening";
  const speaking = state === "speaking";
  const muted = state === "muted";
  const busy = state === "connecting" || state === "ending";
  const statusText = error
    ? t("Voice session error")
    : state === "connecting"
      ? t("Connecting")
      : listening
        ? t("Listening")
        : speaking
          ? t("Speaking")
          : muted
            ? t("Muted")
            : state === "interrupted"
              ? t("Interrupted")
              : state === "ending"
                ? t("Finishing voice session")
                : state === "error"
                  ? t("Voice session error")
                  : t("Realtime Voice");

  return (
    <div className="relative shrink-0">
      {open ? (
        <div
          className="absolute bottom-11 right-0 z-50 w-[min(360px,calc(100vw-3rem))] overflow-hidden rounded-2xl border border-[var(--border)]/70 bg-[var(--card)] shadow-[0_18px_60px_-22px_rgba(0,0,0,0.45)]"
          data-testid="realtime-voice-bubble"
          aria-live="polite"
        >
          <div className="flex items-center gap-3 border-b border-[var(--border)]/45 px-4 py-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                error
                  ? "bg-red-500/12 text-red-600"
                  : speaking
                    ? "bg-violet-500/12 text-violet-600 dark:text-violet-400"
                    : "bg-sky-500/12 text-sky-600 dark:text-sky-400"
              }`}
            >
              {busy ? (
                <Loader2 size={17} className="animate-spin" />
              ) : (
                <VoicePulse active={listening || speaking} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-[var(--foreground)]">
                {t("Realtime Voice")}
              </p>
              <p
                className="mt-0.5 truncate text-[11.5px] text-[var(--muted-foreground)]"
                data-testid="realtime-voice-status"
              >
                {statusText}
              </p>
            </div>
            <button
              type="button"
              onClick={onEnd}
              disabled={state === "ending"}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:bg-red-500/10 hover:text-red-600 disabled:opacity-50"
              aria-label={t("End voice session")}
              title={t("End voice session")}
              data-testid="realtime-end"
            >
              <PhoneOff size={15} strokeWidth={1.9} />
            </button>
          </div>

          <div className="min-h-[82px] px-4 py-3">
            {petDefinition ? (
              <div className="flex items-end gap-3">
                <button
                  type="button"
                  onClick={() => setControlsOpen((value) => !value)}
                  aria-expanded={controlsOpen}
                  aria-label={t("Toggle voice controls")}
                  title={t("Toggle voice controls")}
                  data-testid="realtime-pet-avatar"
                  className="shrink-0 rounded-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                >
                  <PetSprite
                    pet={petDefinition}
                    animation={voicePetAnimationFor(state)}
                    height={64}
                    animate={!reducedMotion}
                  />
                </button>
                <div className="min-w-0 flex-1 pb-1">
                  {transcript ? (
                    <div
                      className="relative rounded-xl rounded-bl-sm border border-[var(--border)]/60 bg-[var(--muted)]/35 px-3 py-2"
                      data-testid="realtime-pet-callout"
                    >
                      <p
                        className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] leading-5 text-[var(--foreground)]"
                        data-testid="realtime-partial-transcript"
                      >
                        {transcript}
                      </p>
                    </div>
                  ) : !error ? (
                    <p className="text-[12.5px] leading-5 text-[var(--muted-foreground)]">
                      {listening
                        ? t("Speak naturally. Your sentence will appear here.")
                        : t("Preparing the live voice session…")}
                    </p>
                  ) : null}
                </div>
              </div>
            ) : (
              <>
                {transcript ? (
                  <p
                    className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] leading-5 text-[var(--foreground)]"
                    data-testid="realtime-partial-transcript"
                  >
                    {transcript}
                  </p>
                ) : !error ? (
                  <p className="text-[12.5px] leading-5 text-[var(--muted-foreground)]">
                    {listening
                      ? t("Speak naturally. Your sentence will appear here.")
                      : t("Preparing the live voice session…")}
                  </p>
                ) : null}
              </>
            )}
            {error ? (
              <p
                className="mt-2 text-[11.5px] leading-relaxed text-red-600"
                role="alert"
                data-testid="realtime-voice-error"
              >
                {t(error)}
              </p>
            ) : null}
          </div>

          {petDefinition && !controlsOpen ? null : (
          <div className="flex items-center justify-between gap-2 border-t border-[var(--border)]/45 bg-[var(--muted)]/20 px-3 py-2.5">
            <button
              type="button"
              onClick={onToggleMute}
              disabled={busy || state === "error"}
              className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/65 hover:text-[var(--foreground)] disabled:opacity-40"
              aria-label={muted ? t("Unmute microphone") : t("Mute microphone")}
              title={muted ? t("Unmute microphone") : t("Mute microphone")}
              data-testid="realtime-mute"
            >
              {muted ? (
                <MicOff size={14} strokeWidth={1.9} />
              ) : (
                <Mic size={14} strokeWidth={1.9} />
              )}
              {muted ? t("Unmute") : t("Mute")}
            </button>
            {speaking || audioOutputReceived ? (
              <button
                type="button"
                onClick={onInterrupt}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-red-500/10 px-3 text-[11.5px] font-medium text-red-600 transition-colors hover:bg-red-500/15"
                aria-label={t("Interrupt voice response")}
                title={t("Interrupt voice response")}
                data-testid="realtime-interrupt"
              >
                <Square size={10} strokeWidth={2.2} className="fill-current" />
                {t("Interrupt")}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5 pr-1 text-[10.5px] text-[var(--muted-foreground)]/75">
                <AudioWaveform size={13} />
                {statusText}
              </span>
            )}
          </div>
          )}

          <span
            className="sr-only"
            data-testid="realtime-audio-output"
            data-received={audioOutputReceived ? "true" : "false"}
            data-count={String(audioOutputCount)}
          />
          <span
            className="sr-only"
            data-testid="realtime-turn-mode"
            data-mode={lastTurnMode ?? ""}
          />
        </div>
      ) : null}

      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={`group relative inline-flex h-8 w-8 items-center justify-center rounded-[10px] transition-[background-color,color,transform] duration-150 active:scale-90 disabled:opacity-40 ${
          state === "error"
            ? "bg-red-500/12 text-red-600"
            : open
              ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
              : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
        }`}
        aria-label={
          sessionActive
            ? t("Stop voice conversation")
            : state === "error"
              ? t("End voice session")
              : t("Start voice conversation")
        }
        title={
          error
            ? t(error)
            : sessionActive
              ? t("Stop voice conversation")
              : t("Start voice conversation")
        }
        aria-expanded={open}
        data-testid="realtime-voice-toggle"
      >
        {state === "connecting" || state === "ending" ? (
          <Loader2 size={16} strokeWidth={1.9} className="animate-spin" />
        ) : (
          <AudioWaveform size={16} strokeWidth={1.9} />
        )}
      </button>
    </div>
  );
}
