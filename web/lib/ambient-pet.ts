/**
 * Maps live chat turn state to an ambient pet animation track.
 *
 * Mirrors the notification mapping in codex-rs/tui/src/pets/ambient.rs:
 * Running → "running", Needs input → "waiting", Ready → "review",
 * Blocked → "failed". Codex gives those states long lifetimes (a completed
 * turn stays in "review" until something new happens), so the mapping here
 * is stateless — the current session status alone decides the track.
 */

export type AmbientPetInput = {
  /** An ask_user card is open and the turn is paused for the user's reply. */
  pendingAskUser: boolean;
  /** A turn is actively streaming on the selected session. */
  isStreaming: boolean;
  /** Runtime status of the selected session ("idle" | "running" | "completed"
   *  | "failed" | "cancelled" | "rejected"); null when nothing has run. */
  status: string | null | undefined;
};

export function ambientAnimationFor({
  pendingAskUser,
  isStreaming,
  status,
}: AmbientPetInput): string {
  // Needs input — the turn is blocked on the user (codex "waiting").
  if (pendingAskUser) return "waiting";
  // Thinking — a turn is live (codex "running").
  if (isStreaming || status === "running") return "running";
  // Blocked — the turn ended without success (codex "failed"). Cancelled and
  // rejected turns are terminal non-success states too.
  if (status === "failed" || status === "cancelled" || status === "rejected") {
    return "failed";
  }
  // Ready — the last turn completed and nothing new is running (codex
  // "review", which likewise lingers until the next turn starts).
  if (status === "completed") return "review";
  return "idle";
}
