"use client";

import { useEffect, useMemo, useState } from "react";

import { petSpriteAtMs, resolveActiveAnimation } from "@/lib/pet-animation";
import {
  PET_FRAME_COLUMNS,
  PET_FRAME_HEIGHT,
  PET_FRAME_ROWS,
  PET_FRAME_WIDTH,
  getPet,
  type PetDefinition,
} from "@/lib/pets";

/** Ambient render height, matching codex-rs PET_TARGET_HEIGHT_PX. */
const DEFAULT_HEIGHT_PX = 75;

type PetSpriteProps = {
  /** Pet id from the catalog, or a full PetDefinition. */
  pet: string | PetDefinition;
  /** Animation track name, e.g. "idle" | "waving" | "failed". */
  animation?: string;
  /** Rendered height in px; width scales proportionally. */
  height?: number;
  /** When false, show the track's first frame without animating. */
  animate?: boolean;
  className?: string;
  title?: string;
};

function firstSprite(pet: PetDefinition, animationName: string): number {
  const animation = pet.animations[animationName] ?? pet.animations.idle;
  return animation?.frames[0]?.sprite ?? 0;
}

/**
 * Renders one frame of a pet spritesheet and advances it on a timeout chain
 * driven by the ported timing model (lib/pet-animation.ts).
 */
export function PetSprite({
  pet,
  animation = "idle",
  height = DEFAULT_HEIGHT_PX,
  animate = true,
  className,
  title,
}: PetSpriteProps) {
  const definition = useMemo(
    () => (typeof pet === "string" ? getPet(pet) : pet),
    [pet],
  );
  const staticSprite = definition ? firstSprite(definition, animation) : 0;
  const [sprite, setSprite] = useState(staticSprite);

  useEffect(() => {
    if (!definition || !animate) return;
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const step = () => {
      if (cancelled) return;
      const elapsed = performance.now() - startedAt;
      const track = resolveActiveAnimation(definition, animation, elapsed);
      if (!track) return;
      const tick = petSpriteAtMs(track, elapsed);
      if (!tick) return;
      setSprite(tick.sprite);
      if (tick.delayMs !== null) {
        timer = setTimeout(step, tick.delayMs);
      }
    };

    timer = setTimeout(step, 0);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [definition, animation, animate]);

  if (!definition) return null;
  const visibleSprite = animate ? sprite : staticSprite;

  const scale = height / PET_FRAME_HEIGHT;
  const frameWidth = PET_FRAME_WIDTH * scale;
  const frameHeight = PET_FRAME_HEIGHT * scale;
  const column = visibleSprite % PET_FRAME_COLUMNS;
  const row = Math.floor(visibleSprite / PET_FRAME_COLUMNS);

  return (
    <div
      role="img"
      aria-label={title ?? definition.displayName}
      title={title ?? definition.displayName}
      className={className}
      style={{
        width: frameWidth,
        height: frameHeight,
        backgroundImage: `url(${definition.spritesheet})`,
        backgroundSize: `${PET_FRAME_COLUMNS * frameWidth}px ${PET_FRAME_ROWS * frameHeight}px`,
        backgroundPosition: `-${column * frameWidth}px -${row * frameHeight}px`,
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
      }}
    />
  );
}

export default PetSprite;
