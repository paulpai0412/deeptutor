"use client";

import { useCallback, useEffect, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";
import { waitForRealtimeIceGatheringComplete } from "@/lib/realtime-voice";

export type RealtimeVoiceProviderStatus = {
  provider: string;
  ready: boolean;
  message: string;
  login_command?: string | null;
};

type RealtimeVoiceSettingsPayload = {
  provider: string;
  model: string;
  voice: string;
  models: string[];
  voices: string[];
  status: RealtimeVoiceProviderStatus;
};

const DEFAULT_STATUS: RealtimeVoiceProviderStatus = {
  provider: "openai_codex",
  ready: false,
  message: "Realtime Voice Provider status is unavailable.",
  login_command: "deeptutor provider login openai-codex",
};

const DEFAULT_SETTINGS: RealtimeVoiceSettingsPayload = {
  provider: "openai_codex",
  model: "gpt-live-1-boulder-alpha",
  voice: "cove",
  models: ["gpt-live-1-boulder-alpha"],
  voices: ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"],
  status: DEFAULT_STATUS,
};

function normalizeStatus(value: unknown): RealtimeVoiceProviderStatus {
  if (!value || typeof value !== "object") return DEFAULT_STATUS;
  const payload = value as Partial<RealtimeVoiceProviderStatus>;
  return {
    provider:
      typeof payload.provider === "string"
        ? payload.provider
        : DEFAULT_STATUS.provider,
    ready: payload.ready === true,
    message:
      typeof payload.message === "string"
        ? payload.message
        : DEFAULT_STATUS.message,
    login_command:
      typeof payload.login_command === "string" ? payload.login_command : null,
  };
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  return items.length > 0 ? items : fallback;
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as {
    detail?: unknown;
  } | null;
  return new Error(
    typeof payload?.detail === "string" && payload.detail
      ? payload.detail
      : fallback,
  );
}

async function createConnectionTestOffer(): Promise<{
  peer: RTCPeerConnection;
  sdp: string;
}> {
  if (typeof RTCPeerConnection === "undefined") {
    throw new Error("Realtime Voice connection testing is not supported in this browser.");
  }
  const peer = new RTCPeerConnection();
  try {
    peer.addTransceiver("audio", { direction: "recvonly" });
    peer.createDataChannel("oai-events");
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForRealtimeIceGatheringComplete(peer);
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("Realtime Voice connection test could not create an offer.");
    return { peer, sdp };
  } catch (error) {
    peer.close();
    throw error;
  }
}

function normalizeSettings(value: unknown): RealtimeVoiceSettingsPayload {
  if (!value || typeof value !== "object") return DEFAULT_SETTINGS;
  const payload = value as Partial<RealtimeVoiceSettingsPayload>;
  return {
    provider:
      typeof payload.provider === "string"
        ? payload.provider
        : DEFAULT_SETTINGS.provider,
    model:
      typeof payload.model === "string" ? payload.model : DEFAULT_SETTINGS.model,
    voice:
      typeof payload.voice === "string" ? payload.voice : DEFAULT_SETTINGS.voice,
    models: stringList(payload.models, DEFAULT_SETTINGS.models),
    voices: stringList(payload.voices, DEFAULT_SETTINGS.voices),
    status: normalizeStatus(payload.status),
  };
}

export function useRealtimeVoiceProvider() {
  const [settings, setSettings] =
    useState<RealtimeVoiceSettingsPayload>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testSucceeded, setTestSucceeded] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch(
        apiUrl("/api/v1/settings/realtime-voice"),
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextSettings = normalizeSettings(await response.json());
      setSettings(nextSettings);
      return nextSettings;
    } catch {
      setError("Could not load Realtime Voice settings.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveSettings = useCallback(
    async (
      patch: Partial<
        Pick<RealtimeVoiceSettingsPayload, "provider" | "model" | "voice">
      >,
    ) => {
      setSaving(true);
      setError(null);
      try {
        const response = await apiFetch(
          apiUrl("/api/v1/settings/realtime-voice"),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              provider: patch.provider ?? settings.provider,
              model: patch.model ?? settings.model,
              voice: patch.voice ?? settings.voice,
            }),
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setSettings(normalizeSettings(await response.json()));
        setTestSucceeded(null);
      } catch {
        setError("Could not save Realtime Voice settings.");
      } finally {
        setSaving(false);
      }
    },
    [settings.model, settings.provider, settings.voice],
  );

  const authorize = useCallback(async () => {
    setAuthorizing(true);
    setError(null);
    try {
      const response = await apiFetch(
        apiUrl("/api/v1/settings/realtime-voice/authorize"),
        { method: "POST" },
      );
      if (!response.ok) {
        throw await responseError(
          response,
          "OpenAI Codex OAuth authorization failed.",
        );
      }
      setSettings(normalizeSettings(await response.json()));
      setTestSucceeded(null);
    } catch (authorizationError) {
      setError(
        authorizationError instanceof Error
          ? authorizationError.message
          : "OpenAI Codex OAuth authorization failed.",
      );
    } finally {
      setAuthorizing(false);
    }
  }, []);

  const testConnection = useCallback(async () => {
    setTesting(true);
    setTestSucceeded(null);
    setError(null);
    let peer: RTCPeerConnection | null = null;
    try {
      const offer = await createConnectionTestOffer();
      peer = offer.peer;
      const response = await apiFetch(
        apiUrl("/api/v1/settings/realtime-voice/test"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sdp: offer.sdp }),
        },
      );
      if (!response.ok) {
        throw await responseError(
          response,
          "Could not test Realtime Voice connection.",
        );
      }
      const nextSettings = normalizeSettings(await response.json());
      setSettings(nextSettings);
      setTestSucceeded(true);
      return true;
    } catch (connectionError) {
      setError(
        connectionError instanceof Error
          ? connectionError.message
          : "Could not test Realtime Voice connection.",
      );
      setTestSucceeded(false);
      return false;
    } finally {
      peer?.close();
      setTesting(false);
    }
  }, []);

  return {
    ...settings,
    loading,
    saving,
    authorizing,
    testing,
    tested: testSucceeded !== null,
    testSucceeded,
    error,
    refresh,
    authorize,
    testConnection,
    setProvider: (provider: "openai_codex") => saveSettings({ provider }),
    setModel: (model: string) => saveSettings({ model }),
    setVoice: (voice: string) => saveSettings({ voice }),
  };
}
