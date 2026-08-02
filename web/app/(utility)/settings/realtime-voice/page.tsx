"use client";

import {
  CheckCircle2,
  Loader2,
  LogIn,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
  selectClass,
} from "@/components/settings/shared";
import { useRealtimeVoiceProvider } from "@/hooks/useRealtimeVoiceProvider";

function voiceLabel(voice: string): string {
  return voice.charAt(0).toUpperCase() + voice.slice(1);
}

export default function RealtimeVoiceSettingsPage() {
  const { t } = useTranslation();
  const {
    provider,
    model,
    voice,
    models,
    voices,
    status,
    loading,
    saving,
    authorizing,
    testing,
    tested,
    testSucceeded,
    error,
    setProvider,
    setModel,
    setVoice,
    authorize,
    testConnection,
  } = useRealtimeVoiceProvider();
  const busy = loading || saving || authorizing;

  return (
    <div data-testid="realtime-voice-settings-page">
      <SettingsPageHeader
        title={t("Realtime Voice")}
        description={t(
          "Configure the server-side GPT-Live model authorization and voice used for live conversations.",
        )}
      />

      <SettingSection
        title={t("Model and authorization")}
        description={t(
          "Realtime Voice uses the server's Codex OAuth login. Select Authorize to open the browser flow; credentials never enter the DeepTutor page.",
        )}
      >
        <SettingRow
          title={t("Provider")}
          description={t("The GPT-Live V3 provider used for live voice sessions.")}
          control={
            <select
              value={provider}
              disabled={busy}
              onChange={(event) =>
                void setProvider(event.target.value as "openai_codex")
              }
              className={`${selectClass} w-64`}
              data-testid="realtime-voice-provider"
            >
              <option value="openai_codex">{t("OpenAI Codex OAuth")}</option>
            </select>
          }
        />
        <SettingRow
          title={t("GPT-Live model")}
          description={t("Only models verified against the official V3 contract are listed.")}
          control={
            <select
              value={model}
              disabled={busy}
              onChange={(event) => void setModel(event.target.value)}
              className={`${selectClass} w-64`}
              data-testid="realtime-voice-model"
            >
              {models.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          }
        />
        <SettingRow
          title={t("Authorization")}
          description={t(status.message)}
          control={
            <div className="flex w-64 flex-col items-end gap-1.5 text-right">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium ${
                  status.ready
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                }`}
                data-testid="realtime-voice-provider-status"
              >
                <ShieldCheck size={13} />
                {status.ready ? t("Connected") : t("Not connected")}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void authorize()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]/55 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="realtime-voice-authorize"
              >
                {authorizing ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <LogIn size={13} />
                )}
                {status.ready ? t("Reauthorize") : t("Authorize")}
              </button>
              {!status.ready && status.login_command ? (
                <code className="max-w-full break-all text-[10.5px] text-[var(--muted-foreground)]">
                  {status.login_command}
                </code>
              ) : null}
            </div>
          }
        />
        <SettingRow
          title={t("Connection test")}
          description={t(
            "Create and immediately close a real GPT-Live V3 AVAS call and sideband without microphone audio.",
          )}
          control={
            <div className="flex w-64 flex-col items-end gap-2">
              <button
                type="button"
                disabled={busy || testing || !status.ready}
                onClick={() => void testConnection()}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[12.5px] font-medium text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]/55 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="realtime-voice-test-connection"
              >
                {testing ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <RefreshCw size={14} />
                )}
                {t("Test connection")}
              </button>
              {tested ? (
                <span
                  className={`inline-flex items-center gap-1 text-[11.5px] ${
                    testSucceeded ? "text-emerald-600" : "text-red-600"
                  }`}
                  role="status"
                  data-testid="realtime-voice-test-result"
                >
                  {testSucceeded ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <XCircle size={13} />
                  )}
                  {testSucceeded
                    ? t("Connection test passed")
                    : t("Connection test failed")}
                </span>
              ) : null}
            </div>
          }
        />
      </SettingSection>

      <SettingSection
        title={t("Voice")}
        description={t("Choose the voice GPT-Live uses for assistant speech.")}
      >
        <SettingRow
          title={t("Voice")}
          description={t("Applied when the next Realtime Voice session starts.")}
          control={
            <select
              value={voice}
              disabled={busy}
              onChange={(event) => void setVoice(event.target.value)}
              className={`${selectClass} w-64`}
              data-testid="realtime-voice-voice"
            >
              {voices.map((item) => (
                <option key={item} value={item}>
                  {voiceLabel(item)}
                </option>
              ))}
            </select>
          }
        />
      </SettingSection>

      {error ? (
        <p
          className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-600"
          role="alert"
          data-testid="realtime-voice-settings-error"
        >
          {t(error)}
        </p>
      ) : null}
    </div>
  );
}
