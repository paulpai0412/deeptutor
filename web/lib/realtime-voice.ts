import type { MessageItem } from "@/context/UnifiedChatContext";
import { buildVisiblePath, tipMessageId } from "@/lib/message-branches";
import type { RealtimeVoiceAssistantSnapshot } from "@/lib/realtime-voice-activity";

/**
 * Merge GPT-Live transcript updates without guessing word boundaries.
 *
 * V3 may stream tiny deltas (including one CJK character or a leading space)
 * and can also repeat the full text-so-far. Provider whitespace is therefore
 * preserved verbatim; cumulative snapshots replace rather than duplicate the
 * sentence.
 */
export function waitForRealtimeIceGatheringComplete(
  peer: RTCPeerConnection,
  timeoutMs = 15_000,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", handleStateChange);
      reject(new Error("Realtime WebRTC ICE gathering did not complete."));
    }, timeoutMs);
    const handleStateChange = () => {
      if (peer.iceGatheringState !== "complete") return;
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", handleStateChange);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", handleStateChange);
  });
}

export function appendRealtimeTranscript(
  current: string,
  update: string,
): string {
  if (!update) return current;
  if (!current) return update.trimStart();
  if (update === current || update.startsWith(current)) return update;
  return current + update;
}

export type RealtimeVoiceTranscriptState = {
  userPartial: string;
  userFinal: string;
  userTurnId: string;
  userMode: "delegated" | "provider" | null;
  assistantText: string;
  assistantTurnId: string;
  assistantFinal: boolean;
};

type RealtimeVoiceTranscriptMessage = {
  type?: string;
  phase?: "partial" | "final";
  mode?: "delegated" | "provider";
  text?: string;
  handoff_id?: string;
  provider_turn_id?: string;
};

export function reduceRealtimeVoiceTranscript(
  current: RealtimeVoiceTranscriptState | undefined,
  message: RealtimeVoiceTranscriptMessage,
): { state: RealtimeVoiceTranscriptState; action: "none" | "delegate" } {
  const state = current ?? {
    userPartial: "",
    userFinal: "",
    userTurnId: "",
    userMode: null,
    assistantText: "",
    assistantTurnId: "",
    assistantFinal: false,
  };
  const text = message.text ?? "";

  if (message.type === "transcript" && message.phase === "partial") {
    return {
      state: {
        ...state,
        userPartial: appendRealtimeTranscript(state.userPartial, text),
      },
      action: "none",
    };
  }
  if (message.type === "transcript" && message.phase === "final") {
    return {
      state: {
        ...state,
        userPartial: text,
        userFinal: text,
        userTurnId: message.provider_turn_id ?? message.handoff_id ?? "",
        userMode: message.mode ?? null,
      },
      action: message.mode === "delegated" ? "delegate" : "none",
    };
  }
  if (message.type === "assistant_transcript") {
    return {
      state: {
        ...state,
        assistantText:
          message.phase === "final"
            ? text
            : appendRealtimeTranscript(state.assistantText, text),
        assistantTurnId: message.provider_turn_id ?? state.assistantTurnId,
        assistantFinal: message.phase === "final",
      },
      action: "none",
    };
  }
  return { state, action: "none" };
}

export function mergeRealtimeVoiceAssistant(
  messages: MessageItem[],
  selectedBranches: Record<string, number>,
  transcript: RealtimeVoiceAssistantSnapshot,
  optimisticId = -1,
): MessageItem[] {
  if (!transcript.text) return messages;

  if (transcript.turnId) {
    const existing = messages.find(
      (message) => message.providerTurnId === transcript.turnId,
    );
    if (existing) {
      return messages.map((message) =>
        message === existing ? { ...message, content: transcript.text } : message,
      );
    }
  }

  const visible = buildVisiblePath(messages, selectedBranches).messages;
  if (!transcript.delegated) {
    return [
      ...messages,
      {
        id: optimisticId,
        role: "assistant",
        content: transcript.text,
        capability: "realtime_voice",
        parentMessageId: tipMessageId(visible),
        providerTurnId: transcript.turnId,
      },
    ];
  }

  const target = visible.findLast((message) => message.role === "assistant");
  if (!target) return messages;
  return messages.map((message) =>
    message === target
      ? {
          ...message,
          content: transcript.text,
          providerTurnId: transcript.turnId,
        }
      : message,
  );
}
