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
