/**
 * Ambient companion pets, ported from OpenAI Codex CLI
 * (codex-rs/tui/src/pets, Apache-2.0 — see public/pets/NOTICE.md).
 *
 * Spritesheets: 192×208 px per frame, 8 columns × 9 rows = 72 frames.
 * Row 0 is the idle loop; rows 1–8 are one-shot state tracks that chain
 * into idle, exactly as the Rust model defines them.
 */

export const PET_FRAME_WIDTH = 192;
export const PET_FRAME_HEIGHT = 208;
export const PET_FRAME_COLUMNS = 8;
export const PET_FRAME_ROWS = 9;
export const PET_FRAME_COUNT = PET_FRAME_COLUMNS * PET_FRAME_ROWS;

export const DISABLED_PET_ID = "disabled";
export const DEFAULT_PET_ID = "codex";

export type PetFrame = { sprite: number; durationMs: number };

export type PetAnimation = {
  frames: PetFrame[];
  /** Index into frames[] where the loop restarts; null = play once. */
  loopStart: number | null;
  fallback: string;
};

const IDLE: PetAnimation = {
  frames: [
    { sprite: 0, durationMs: 1680 },
    { sprite: 1, durationMs: 660 },
    { sprite: 2, durationMs: 660 },
    { sprite: 3, durationMs: 840 },
    { sprite: 4, durationMs: 840 },
    { sprite: 5, durationMs: 1920 },
  ],
  loopStart: 0,
  fallback: "idle",
};

/** Codex's app_state_animation: play the row 3×, then chain the idle frames
 * and loop within that idle tail. */
function stateAnimation(
  rowIndex: number,
  frameCount: number,
  frameDurationMs: number,
  finalFrameDurationMs: number,
): PetAnimation {
  const primary: PetFrame[] = [];
  for (let col = 0; col < frameCount; col += 1) {
    primary.push({
      sprite: rowIndex * PET_FRAME_COLUMNS + col,
      durationMs: col === frameCount - 1 ? finalFrameDurationMs : frameDurationMs,
    });
  }
  return {
    frames: [...primary, ...primary, ...primary, ...IDLE.frames],
    loopStart: primary.length * 3,
    fallback: "idle",
  };
}

function builtinAnimations(): Record<string, PetAnimation> {
  const waving = stateAnimation(3, 4, 140, 280);
  const jumping = stateAnimation(4, 5, 140, 280);
  const failed = stateAnimation(5, 8, 140, 240);
  const runningRight = stateAnimation(1, 8, 120, 220);
  const runningLeft = stateAnimation(2, 8, 120, 220);
  return {
    idle: IDLE,
    "running-right": runningRight,
    "running-left": runningLeft,
    move_right: runningRight,
    move_left: runningLeft,
    waving,
    wave: waving,
    jumping,
    bounce: jumping,
    failed,
    sad: failed,
    waiting: stateAnimation(6, 6, 150, 260),
    running: stateAnimation(7, 6, 120, 220),
    review: stateAnimation(8, 6, 150, 280),
  };
}

export type PetDefinition = {
  id: string;
  displayName: string;
  description: string;
  spritesheet: string;
  animations: Record<string, PetAnimation>;
};

function definePet(
  id: string,
  displayName: string,
  description: string,
): PetDefinition {
  return {
    id,
    displayName,
    description,
    spritesheet: `/pets/${id}-spritesheet-v4.webp`,
    animations: builtinAnimations(),
  };
}

/** The eight built-in Codex pets, same order as the source catalog. */
export const PETS: readonly PetDefinition[] = [
  definePet("codex", "Codex", "The original Codex companion"),
  definePet("dewey", "Dewey", "A tidy duck for calm workspace days"),
  definePet("fireball", "Fireball", "Hot path energy for fast iteration"),
  definePet("rocky", "Rocky", "A steady rock when the diff gets large"),
  definePet("seedy", "Seedy", "Small green shoots for new ideas"),
  definePet("stacky", "Stacky", "A balanced stack for deep work"),
  definePet("bsod", "BSOD", "A tiny blue-screen gremlin"),
  definePet("null-signal", "Null Signal", "Quiet signal from the void"),
];

export function getPet(id: string | null | undefined): PetDefinition | null {
  if (!id || id === DISABLED_PET_ID) return null;
  return PETS.find((pet) => pet.id === id) ?? null;
}
