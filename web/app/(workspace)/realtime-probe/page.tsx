"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useUnifiedChat } from "@/context/UnifiedChatContext";
import { useRealtimeVoiceSession } from "@/hooks/useRealtimeVoiceSession";

/**
 * Explicit real-environment probe for WSL development.
 *
 * Open this page in Windows Chrome/Edge (not Chromium inside WSL) so
 * getUserMedia reaches the Windows microphone. No synthetic media or network
 * interception is used. The normal unified turn path receives every final
 * transcript through sendMessage.
 */
export default function RealtimeProbePage() {
  const { t } = useTranslation();
  const [clientReady, setClientReady] = useState(false);
  useEffect(() => {
    const timeout = window.setTimeout(() => setClientReady(true), 0);
    return () => window.clearTimeout(timeout);
  }, []);
  const { state: chatState, sendMessage, loadSession } = useUnifiedChat();
  const handleFinalTranscript = useCallback(
    // Realtime Voice turns append to the persisted session tail; the
    // visible tip can lag behind the backend save while speaking.
    (text: string) =>
      sendMessage(text, undefined, undefined, undefined, undefined, {
        appendToLatest: true,
      }),
    [sendMessage],
  );
  const handleSessionReady = useCallback(
    async (sessionId: string) => {
      if (chatState.sessionId !== sessionId) await loadSession(sessionId);
    },
    [chatState.sessionId, loadSession],
  );
  const voice = useRealtimeVoiceSession(handleFinalTranscript, {
    sessionId: chatState.sessionId,
    capability: "chat",
    knowledgeBases: chatState.knowledgeBases,
    pageContext: "realtime probe",
    language: chatState.language,
    onSessionReady: handleSessionReady,
  });
  const latestAssistant = [...chatState.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-5 overflow-y-auto p-6">
      <header>
        <h1 className="text-xl font-semibold text-[var(--foreground)]">
          {t("Codex OAuth Realtime Voice Probe")}
        </h1>
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
          {t("Use Windows Chrome or Edge with a physical microphone. This page uses real OAuth, WebRTC, backend, frontend, and Codex network transport.")}
        </p>
      </header>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={voice.start}
            disabled={!clientReady || voice.active}
            data-testid="realtime-probe-start"
            className="rounded-lg bg-[var(--primary)] px-3 py-2 text-sm text-[var(--primary-foreground)] disabled:opacity-50"
          >
            {t("Start voice conversation")}
          </button>
          <button
            type="button"
            onClick={voice.toggleMute}
            disabled={!voice.active}
            data-testid="realtime-probe-mute"
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
          >
            {voice.state === "muted" ? t("Unmute microphone") : t("Mute microphone")}
          </button>
          <button
            type="button"
            onClick={voice.interrupt}
            disabled={!voice.active}
            data-testid="realtime-probe-interrupt"
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
          >
            {t("Interrupt voice response")}
          </button>
          <button
            type="button"
            onClick={voice.end}
            disabled={!voice.active}
            data-testid="realtime-probe-end"
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm disabled:opacity-50"
          >
            {t("End voice session")}
          </button>
        </div>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-[var(--muted-foreground)]">{t("Session state")}</dt>
            <dd data-testid="realtime-probe-status" className="font-medium">
              {t("Realtime probe state: {{state}}", { state: t(voice.state) })}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted-foreground)]">{t("Assistant audio track")}</dt>
            <dd data-testid="realtime-probe-audio" className="font-medium">
              {voice.audioOutputReceived
                ? t("Received audio tracks: {{count}}", { count: voice.audioOutputCount })
                : t("Assistant audio not received")}
            </dd>
          </div>
        </dl>
        {voice.error ? (
          <p className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-700" role="alert">
            {t(voice.error)}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h2 className="font-medium">{t("Live transcript")}</h2>
        <p
          data-testid="realtime-probe-transcript"
          aria-live="polite"
          className="mt-3 min-h-10 whitespace-pre-wrap text-sm text-[var(--muted-foreground)]"
        >
          {voice.partialTranscript || t("Speak one complete sentence after connecting.")}
        </p>
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <h2 className="font-medium">{t("ChatOrchestrator result")}</h2>
        <p className="mt-2 text-sm text-[var(--muted-foreground)]">
          {t("Unified turn: {{state}}", {
            state: chatState.isStreaming ? t("running") : t("idle"),
          })}
        </p>
        <p
          data-testid="realtime-probe-assistant"
          className="mt-3 whitespace-pre-wrap text-sm text-[var(--foreground)]"
        >
          {latestAssistant?.content || t("No assistant response yet.")}
        </p>
      </section>
    </main>
  );
}
