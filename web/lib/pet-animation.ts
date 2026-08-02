/**
 * Pet animation playback engine, ported from OpenAI Codex CLI
 * (codex-rs/tui/src/pets/ambient.rs, Apache-2.0 — see public/pets/NOTICE.md).
 *
 * Pure timing logic, no DOM/React: given an animation and an elapsed time,
 * return which sprite should be visible and how long until the next tick.
 * Semantics mirror `current_animation_frame` / `frame_at_elapsed`:
 * - animations with a valid `loopStart` loop within frames[loopStart..]
 *   after playing the prefix once;
 * - animations with `loopStart === null` hold their final frame once done;
 * - `resolveActiveAnimation` mirrors `current_animation`: a finished
 *   one-shot hands off to its `fallback` track.
 */

import type { PetAnimation, PetDefinition } from "./pets";

export type PetFrameTick = {
  sprite: number;
  /** Milliseconds until the next frame; null when the animation settled. */
  delayMs: number | null;
};

export function petAnimationTotalMs(animation: PetAnimation): number {
  return animation.frames.reduce((total, frame) => total + frame.durationMs, 0);
}

function frameAtElapsed(animation: PetAnimation, elapsedMs: number): PetFrameTick | null {
  let remaining = elapsedMs;
  for (const frame of animation.frames) {
    const frameMs = Math.max(frame.durationMs, 1);
    if (remaining < frameMs) {
      return { sprite: frame.sprite, delayMs: frameMs - remaining };
    }
    remaining -= frameMs;
  }
  const last = animation.frames[animation.frames.length - 1];
  return last ? { sprite: last.sprite, delayMs: null } : null;
}

export function petSpriteAtMs(animation: PetAnimation, elapsedMs: number): PetFrameTick | null {
  if (animation.frames.length <= 1) {
    const first = animation.frames[0];
    return first ? { sprite: first.sprite, delayMs: null } : null;
  }

  const loopStart = animation.loopStart;
  if (loopStart !== null && loopStart < animation.frames.length) {
    const totalMs = petAnimationTotalMs(animation);
    const prefixMs = animation.frames
      .slice(0, loopStart)
      .reduce((total, frame) => total + frame.durationMs, 0);
    const loopMs = animation.frames
      .slice(loopStart)
      .reduce((total, frame) => total + frame.durationMs, 0);
    const effectiveElapsed =
      elapsedMs >= totalMs && loopMs > 0
        ? prefixMs + ((elapsedMs - prefixMs) % loopMs)
        : elapsedMs;
    return frameAtElapsed(animation, effectiveElapsed);
  }

  if (elapsedMs >= petAnimationTotalMs(animation)) {
    const last = animation.frames[animation.frames.length - 1];
    return last ? { sprite: last.sprite, delayMs: null } : null;
  }
  return frameAtElapsed(animation, elapsedMs);
}

/**
 * Resolve which track should be playing `elapsedMs` after `name` started:
 * the named track, falling back to `idle` when the name is unknown, and to
 * the track's `fallback` once a one-shot (loopStart === null) completes.
 */
export function resolveActiveAnimation(
  pet: PetDefinition,
  name: string,
  elapsedMs: number,
): PetAnimation | null {
  const animation = pet.animations[name] ?? pet.animations.idle;
  if (!animation) return null;
  if (
    animation.loopStart === null &&
    elapsedMs >= petAnimationTotalMs(animation) &&
    pet.animations[animation.fallback]
  ) {
    return pet.animations[animation.fallback];
  }
  return animation;
}
