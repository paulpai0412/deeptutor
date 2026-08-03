"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { wsUrl } from "@/lib/api";
import {
  appendRealtimeTranscript,
  waitForRealtimeIceGatheringComplete,
} from "@/lib/realtime-voice";
import { setRealtimeVoiceActive } from "@/lib/realtime-voice-activity";

export type RealtimeVoiceSessionState =
  | "idle"
  | "connecting"
  | "listening"
  | "muted"
  | "speaking"
  | "interrupted"
  | "ending"
  | "error";

type RealtimeVoiceMessage = {
  type?: string;
  state?: RealtimeVoiceSessionState | "connected" | "ended";
  phase?: "partial" | "final";
  text?: string;
  message?: string;
  handoff_id?: string;
  session_id?: string;
  mode?: "delegated" | "transcript";
  sdp?: string;
};

export type RealtimeStartedTurn = {
  sessionId: string;
  turnId: string;
};

export type RealtimeVoiceSessionOptions = {
  sessionId?: string | null;
  capability?: string | null;
  knowledgeBases?: string[];
  paperLibraryId?: string | null;
  paperId?: string | null;
  examMode?: boolean;
  pageContext?: string;
  questionContext?: string;
  language?: string;
  onSessionReady?: (sessionId: string) => void | Promise<void>;
};

function waitForRealtimeContext(
  socket: WebSocket,
  context: Record<string, unknown>,
  sessionId?: string | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      fail(new Error("Realtime Voice Session context preparation timed out."));
    }, 30_000);
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      reject(error);
    };
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "prepare",
          ...(sessionId ? { session_id: sessionId } : {}),
          context,
        }),
      );
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as {
          type?: string;
          message?: string;
        };
        if (message.type === "context_ready") {
          finish();
        } else if (message.type === "error") {
          fail(new Error(message.message || "Realtime Voice context is unavailable."));
        }
      } catch {
        fail(new Error("Realtime Voice Session returned invalid context data."));
      }
    };
    socket.onerror = () => fail(new Error("Realtime Voice Session could not connect."));
    socket.onclose = () => {
      fail(new Error("Realtime Voice Session ended during context preparation."));
    };
  });
}

/**
 * Browser-side GPT-Live AVAS session.
 *
 * The browser owns only microphone/playback media. OAuth and the provider
 * sideband remain server-side; finalized speech enters the normal DeepTutor
 * turn path through `onFinalTranscript`.
 */
export function useRealtimeVoiceSession(
  onFinalTranscript: (
    text: string,
  ) => void | RealtimeStartedTurn | null | Promise<void | RealtimeStartedTurn | null>,
  options: RealtimeVoiceSessionOptions = {},
) {
  const [state, setState] = useState<RealtimeVoiceSessionState>("idle");
  const [partialTranscript, setPartialTranscript] = useState("");

  // Broadcast liveness so cross-tree consumers (the workspace AmbientPet) can
  // yield the stage to the in-bubble pet avatar while a session is live.
  useEffect(() => {
    setRealtimeVoiceActive(state !== "idle");
  }, [state]);
  useEffect(() => {
    return () => setRealtimeVoiceActive(false);
  }, []);
  const [audioOutputReceived, setAudioOutputReceived] = useState(false);
  const [audioOutputCount, setAudioOutputCount] = useState(0);
  const [lastTurnMode, setLastTurnMode] = useState<"delegated" | "transcript" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const endFallbackRef = useRef<number | null>(null);
  // Soft interruption: speech-start pauses playback locally while a grace
  // timer decides whether a real delegation follows. False starts (stumble,
  // cough, "uh…") resume the in-flight answer instead of killing the turn.
  const softInterruptTimerRef = useRef<number | null>(null);
  const softSuppressedRef = useRef(false);
  const intentionalCloseRef = useRef(false);
  const ignoreAudioRef = useRef(false);
  const mutedRef = useRef(false);
  const assistantPendingRef = useRef(false);
  const outputActiveRef = useRef(false);
  const interruptionSentRef = useRef(false);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  const onSessionReadyRef = useRef(options.onSessionReady);
  const sessionReadyRef = useRef<Promise<void>>(Promise.resolve());
  const handoffIdRef = useRef<string | null>(null);
  const transcriptCommittedRef = useRef(false);
  const sessionIdRef = useRef(options.sessionId);
  const reportedAudioEventsRef = useRef(new Set<string>());

  useEffect(() => {
    sessionIdRef.current = options.sessionId;
  }, [options.sessionId]);

  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  useEffect(() => {
    onSessionReadyRef.current = options.onSessionReady;
  }, [options.onSessionReady]);

  const pauseRemoteAudio = useCallback(() => {
    remoteAudioRef.current?.pause();
    outputActiveRef.current = false;
  }, []);

  const releaseAudio = useCallback(() => {
    const audio = remoteAudioRef.current;
    if (audio) {
      audio.pause();
      audio.srcObject = null;
    }
    remoteAudioRef.current = null;
    remoteStreamRef.current = null;
    outputActiveRef.current = false;
  }, []);

  const releaseStream = useCallback(() => {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    mutedRef.current = false;
  }, []);

  const clearSoftInterrupt = useCallback(() => {
    if (softInterruptTimerRef.current !== null) {
      window.clearTimeout(softInterruptTimerRef.current);
      softInterruptTimerRef.current = null;
    }
    softSuppressedRef.current = false;
  }, []);

  const closeSession = useCallback(() => {
    intentionalCloseRef.current = true;
    clearSoftInterrupt();
    if (endFallbackRef.current !== null) {
      window.clearTimeout(endFallbackRef.current);
      endFallbackRef.current = null;
    }
    handoffIdRef.current = null;
    transcriptCommittedRef.current = false;
    assistantPendingRef.current = false;
    interruptionSentRef.current = false;
    ignoreAudioRef.current = false;
    releaseStream();
    releaseAudio();
    socketRef.current?.close();
    socketRef.current = null;
    setPartialTranscript("");
    setState("idle");
  }, [clearSoftInterrupt, releaseAudio, releaseStream]);

  const requestInterruption = useCallback(() => {
    if (
      interruptionSentRef.current ||
      (!assistantPendingRef.current && !outputActiveRef.current)
    ) {
      return;
    }
    interruptionSentRef.current = true;
    ignoreAudioRef.current = true;
    assistantPendingRef.current = false;
    clearSoftInterrupt();
    pauseRemoteAudio();
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "cancel_output" }));
    }
    setState("interrupted");
  }, [clearSoftInterrupt, pauseRemoteAudio]);

  const reportAudioEvent = useCallback((name: string, detail = "") => {
    if (reportedAudioEventsRef.current.has(name)) return;
    reportedAudioEventsRef.current.add(name);
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        type: "client_diagnostic",
        event: name,
        detail: detail.slice(0, 160),
      }),
    );
  }, []);

  const primeRemoteAudio = useCallback(async (): Promise<boolean> => {
    const audio = remoteAudioRef.current;
    const stream = remoteStreamRef.current;
    if (!audio || !stream) return false;
    // Codex mode: one audio source (GPT-Live), always playable. There is no
    // playback authorization — the protocol has no ownership signal for
    // audio, so gating it only created races (issue #33).
    audio.muted = false;
    if (audio.srcObject !== stream) audio.srcObject = stream;
    try {
      await audio.play();
      reportAudioEvent(
        "audio_play_resolved",
        `paused=${audio.paused} muted=${audio.muted} volume=${audio.volume}`,
      );
      return true;
    } catch (error) {
      reportAudioEvent(
        "audio_play_failed",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      return false;
    }
  }, [reportAudioEvent]);

  const resumeRemoteAudio = useCallback(async (): Promise<boolean> => {
    const ready = await primeRemoteAudio();
    const audio = remoteAudioRef.current;
    if (!ready || !audio) return false;
    audio.muted = false;
    return true;
  }, [primeRemoteAudio]);

  // Speech-start: pause playback locally and wait to see whether this becomes
  // a real delegated utterance. Only then is the running turn cancelled
  // (server-side, by the delegation); a false start resumes playback.
  const requestSoftInterruption = useCallback(() => {
    if (
      softSuppressedRef.current ||
      interruptionSentRef.current ||
      (!assistantPendingRef.current && !outputActiveRef.current)
    ) {
      return;
    }
    softSuppressedRef.current = true;
    if (remoteAudioRef.current) remoteAudioRef.current.muted = true;
    pauseRemoteAudio();
    if (softInterruptTimerRef.current !== null) {
      window.clearTimeout(softInterruptTimerRef.current);
    }
    softInterruptTimerRef.current = window.setTimeout(() => {
      softInterruptTimerRef.current = null;
      softSuppressedRef.current = false;
      // False start: no turn took over and the answer is still going —
      // resume it as if nothing happened.
      if (outputActiveRef.current || assistantPendingRef.current) {
        if (remoteAudioRef.current) remoteAudioRef.current.muted = false;
        void resumeRemoteAudio();
      }
    }, 1200);
  }, [pauseRemoteAudio, resumeRemoteAudio]);

  const start = useCallback(async () => {
    if (state !== "idle") return;
    setError(null);
    setPartialTranscript("");
    setAudioOutputReceived(false);
    setAudioOutputCount(0);
    setLastTurnMode(null);
    ignoreAudioRef.current = false;
    assistantPendingRef.current = false;
    outputActiveRef.current = false;
    interruptionSentRef.current = false;
    handoffIdRef.current = null;
    transcriptCommittedRef.current = false;
    mutedRef.current = false;
    intentionalCloseRef.current = false;
    reportedAudioEventsRef.current.clear();

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof WebSocket === "undefined" ||
      typeof RTCPeerConnection === "undefined"
    ) {
      setError("Realtime Voice Session is not supported in this browser.");
      setState("error");
      return;
    }

    setState("connecting");
    try {
      const context: Record<string, unknown> = {
        capability: options.capability || "chat",
        knowledge_bases: options.knowledgeBases || [],
        language: options.language || "en",
        ...(options.paperLibraryId
          ? { paper_library_id: options.paperLibraryId }
          : {}),
        ...(options.paperId ? { paper_id: options.paperId } : {}),
        ...(options.examMode ? { exam_mode: true } : {}),
        ...(options.pageContext ? { page_context: options.pageContext } : {}),
        ...(options.questionContext
          ? { question_context: options.questionContext }
          : {}),
      };
      const socket = new WebSocket(wsUrl("/api/v1/voice/realtime"));
      socketRef.current = socket;
      await waitForRealtimeContext(socket, context, sessionIdRef.current);

      // Context is access-checked and preloaded server-side before the browser
      // requests microphone permission or creates a Codex WebRTC call.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);

      // Codex's official AVAS contract requires this channel in the SDP. Raw
      // provider payloads stay private to the hook and are never persisted.
      const providerEvents = peer.createDataChannel("oai-events");
      dataChannelRef.current = providerEvents;
      providerEvents.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const payload = JSON.parse(event.data) as {
            type?: string;
            turn?: { role?: string };
          };
          if (payload.type === "input_transcript.added") {
            requestSoftInterruption();
            return;
          }
          if (payload.type === "output_audio.delta" && softSuppressedRef.current) {
            return;
          }
          if (payload.type === "output_audio.delta") {
            // The PCM/base64 field is intentionally ignored. WebRTC plays the
            // media track; React stores only this content-free receipt signal.
            reportAudioEvent("provider_audio_delta");
            ignoreAudioRef.current = false;
            interruptionSentRef.current = false;
            if (!outputActiveRef.current) {
              outputActiveRef.current = true;
              setAudioOutputReceived(true);
              setAudioOutputCount((count) => count + 1);
            }
            setState("speaking");
            void resumeRemoteAudio();
          } else if (
            payload.type === "turn.done" &&
            payload.turn?.role === "assistant"
          ) {
            void peer.getStats().then((stats) => {
              for (const report of stats.values()) {
                if (report.type !== "inbound-rtp" || report.kind !== "audio") continue;
                reportAudioEvent(
                  "inbound_audio_stats",
                  `packets=${report.packetsReceived ?? 0} bytes=${report.bytesReceived ?? 0} lost=${report.packetsLost ?? 0} energy=${report.totalAudioEnergy ?? 0}`,
                );
                break;
              }
            });
            assistantPendingRef.current = false;
            outputActiveRef.current = false;
            setState(mutedRef.current ? "muted" : "listening");
          }
        } catch {
          setError("Realtime Voice Session returned invalid provider data.");
          closeSession();
        }
      };

      peer.ontrack = (event) => {
        const remoteStream = event.streams[0];
        if (!remoteStream) return;
        reportAudioEvent(
          "remote_track",
          `audio_tracks=${remoteStream.getAudioTracks().length}`,
        );
        remoteStreamRef.current = remoteStream;
        const audio = remoteAudioRef.current ?? new Audio();
        audio.autoplay = true;
        audio.muted = false;
        audio.onplaying = () => {
          reportAudioEvent(
            "audio_onplaying",
            `paused=${audio.paused} muted=${audio.muted} volume=${audio.volume}`,
          );
          if (!outputActiveRef.current) {
            outputActiveRef.current = true;
            setAudioOutputReceived(true);
            setAudioOutputCount((count) => count + 1);
          }
          setState("speaking");
        };
        audio.srcObject = remoteStream;
        remoteAudioRef.current = audio;
        void primeRemoteAudio();
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") {
          setState(mutedRef.current ? "muted" : "listening");
          return;
        }
        if (["failed", "closed"].includes(peer.connectionState)) {
          if (!intentionalCloseRef.current) {
            setError("Realtime WebRTC media connection failed.");
            closeSession();
          }
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForRealtimeIceGatheringComplete(peer);
      const localDescription = peer.localDescription;
      if (!localDescription?.sdp) {
        throw new Error("Realtime WebRTC offer SDP is empty.");
      }

      socket.onmessage = (event) => {
        let message: RealtimeVoiceMessage;
        try {
          message = JSON.parse(event.data) as RealtimeVoiceMessage;
        } catch {
          setError("Realtime Voice Session returned invalid data.");
          closeSession();
          return;
        }

        if (message.type === "session_ready") {
          const sessionId = (message.session_id || "").trim();
          if (!sessionId) {
            setError("Realtime Voice Session returned an invalid session.");
            closeSession();
            return;
          }
          sessionIdRef.current = sessionId;
          sessionReadyRef.current = Promise.resolve(
            onSessionReadyRef.current?.(sessionId),
          ).then(() => undefined);
          return;
        }
        if (message.type === "webrtc_answer") {
          if (!message.sdp) {
            setError("Realtime Voice Session returned an empty WebRTC answer.");
            closeSession();
            return;
          }
          void peer
            .setRemoteDescription({ type: "answer", sdp: message.sdp })
            .catch(() => {
              setError("Realtime Voice Session returned an invalid WebRTC answer.");
              closeSession();
            });
          return;
        }
        if (message.type === "state") {
          if (message.state === "connected" || message.state === "listening") {
            setState(mutedRef.current ? "muted" : "listening");
          } else if (message.state === "speaking") {
            setState("speaking");
          } else if (message.state === "interrupted") {
            pauseRemoteAudio();
            setState("interrupted");
          } else if (message.state === "ended") {
            closeSession();
          }
          return;
        }
        if (message.type === "audio_output") {
          if (softSuppressedRef.current) return;
          ignoreAudioRef.current = false;
          interruptionSentRef.current = false;
          if (!outputActiveRef.current) {
            outputActiveRef.current = true;
            setAudioOutputReceived(true);
            setAudioOutputCount((count) => count + 1);
          }
          setState("speaking");
          void resumeRemoteAudio();
          return;
        }
        if (message.type === "assistant_transcript" && message.phase === "final") {
          assistantPendingRef.current = false;
          return;
        }
        if (message.type === "handoff") {
          setError(null);
          handoffIdRef.current = message.handoff_id || null;
          return;
        }
        if (message.type === "transcript") {
          const update = message.text || "";
          if (message.phase === "partial") {
            if (!update) return;
            setError(null);
            const reset = transcriptCommittedRef.current;
            transcriptCommittedRef.current = false;
            setPartialTranscript((current) =>
              appendRealtimeTranscript(reset ? "" : current, update),
            );
          } else if (
            message.phase === "final" &&
            (message.mode === "delegated" || message.mode === "transcript")
          ) {
            const text = update.trim();
            setLastTurnMode(message.mode);
            transcriptCommittedRef.current = true;
            setPartialTranscript(text);
            const handoffId = handoffIdRef.current;
            handoffIdRef.current = null;
            if (!text || !handoffId) {
              setError("Realtime Voice Session returned an invalid finalized turn.");
              closeSession();
              return;
            }
            assistantPendingRef.current = true;
            interruptionSentRef.current = false;
            void sessionReadyRef.current
              .then(() => onFinalTranscriptRef.current(text))
              .then((started) => {
                if (
                  !started ||
                  typeof started !== "object" ||
                  !started.turnId ||
                  !started.sessionId ||
                  socket.readyState !== WebSocket.OPEN
                ) {
                  assistantPendingRef.current = false;
                  setError("The finalized voice turn could not start.");
                  closeSession();
                  return;
                }
                socket.send(
                  JSON.stringify({
                    type: "turn_started",
                    handoff_id: handoffId,
                    turn_id: started.turnId,
                    session_id: started.sessionId,
                  }),
                );
              })
              .catch(() => {
                assistantPendingRef.current = false;
                setError("The finalized voice turn could not start.");
                closeSession();
              });
          }
          return;
        }
        if (message.type === "error") {
          setError(message.message || "Realtime Voice Session failed.");
          closeSession();
        }
      };
      socket.onerror = () => {
        setError("Realtime Voice Session could not connect.");
        closeSession();
      };
      socket.onclose = () => {
        socketRef.current = null;
        releaseStream();
        releaseAudio();
        if (!intentionalCloseRef.current) {
          setError((current) => current || "Realtime Voice Session ended unexpectedly.");
          setState("error");
        } else {
          setState("idle");
        }
      };
      if (socket.readyState !== WebSocket.OPEN) {
        throw new Error("Realtime Voice Session control channel is not ready.");
      }
      socket.send(JSON.stringify({ type: "start", sdp: localDescription.sdp }));
    } catch (err) {
      socketRef.current?.close();
      socketRef.current = null;
      releaseStream();
      releaseAudio();
      setError(err instanceof Error ? err.message : "Microphone permission denied.");
      setState("error");
    }
  }, [
    closeSession,
    pauseRemoteAudio,
    releaseAudio,
    releaseStream,
    reportAudioEvent,
    requestSoftInterruption,
    resumeRemoteAudio,
    state,
    options,
    primeRemoteAudio,
  ]);

  const end = useCallback(() => {
    if (state === "idle") {
      transcriptCommittedRef.current = false;
      setError(null);
      setPartialTranscript("");
      return;
    }
    setState("ending");
    intentionalCloseRef.current = true;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "stop" }));
      endFallbackRef.current = window.setTimeout(closeSession, 2_000);
    } else {
      closeSession();
    }
  }, [closeSession, state]);

  const interrupt = useCallback(() => {
    if (state !== "idle") requestInterruption();
  }, [requestInterruption, state]);

  const toggleMute = useCallback(() => {
    if (state === "idle") return;
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setState(nextMuted ? "muted" : "listening");
  }, [state]);

  const toggle = useCallback(() => {
    if (state === "idle") void start();
    else end();
  }, [end, start, state]);

  useEffect(() => {
    return () => {
      intentionalCloseRef.current = true;
      if (endFallbackRef.current !== null) {
        window.clearTimeout(endFallbackRef.current);
      }
      handoffIdRef.current = null;
      transcriptCommittedRef.current = false;
      releaseStream();
      releaseAudio();
      socketRef.current?.close();
    };
  }, [releaseAudio, releaseStream]);

  return {
    state,
    partialTranscript,
    audioOutputReceived,
    audioOutputCount,
    lastTurnMode,
    error,
    start,
    end,
    interrupt,
    toggleMute,
    toggle,
    active: state !== "idle" && state !== "error",
  };
}
