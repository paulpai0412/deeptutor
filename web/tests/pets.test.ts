import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  petAnimationTotalMs,
  petSpriteAtMs,
  resolveActiveAnimation,
} from "../lib/pet-animation";
import {
  DEFAULT_PET_ID,
  DISABLED_PET_ID,
  PETS,
  PET_FRAME_COUNT,
  getPet,
  type PetAnimation,
  type PetDefinition,
} from "../lib/pets";

// Expected values mirror codex-rs/tui/src/pets/catalog.rs (BUILTIN_PETS).
const EXPECTED_CATALOG = [
  ["codex", "Codex", "The original Codex companion"],
  ["dewey", "Dewey", "A tidy duck for calm workspace days"],
  ["fireball", "Fireball", "Hot path energy for fast iteration"],
  ["rocky", "Rocky", "A steady rock when the diff gets large"],
  ["seedy", "Seedy", "Small green shoots for new ideas"],
  ["stacky", "Stacky", "A balanced stack for deep work"],
  ["bsod", "BSOD", "A tiny blue-screen gremlin"],
  ["null-signal", "Null Signal", "Quiet signal from the void"],
] as const;

// Expected values mirror codex-rs/tui/src/pets/model.rs (default_animations).
const IDLE_FRAMES = [
  [0, 1680],
  [1, 660],
  [2, 660],
  [3, 840],
  [4, 840],
  [5, 1920],
] as const;

const STATE_TRACKS = {
  "running-right": { row: 1, frames: 8, durationMs: 120, finalMs: 220 },
  "running-left": { row: 2, frames: 8, durationMs: 120, finalMs: 220 },
  waving: { row: 3, frames: 4, durationMs: 140, finalMs: 280 },
  jumping: { row: 4, frames: 5, durationMs: 140, finalMs: 280 },
  failed: { row: 5, frames: 8, durationMs: 140, finalMs: 240 },
  waiting: { row: 6, frames: 6, durationMs: 150, finalMs: 260 },
  running: { row: 7, frames: 6, durationMs: 120, finalMs: 220 },
  review: { row: 8, frames: 6, durationMs: 150, finalMs: 280 },
} as const;

const TRACK_ALIASES = {
  move_right: "running-right",
  move_left: "running-left",
  wave: "waving",
  bounce: "jumping",
  sad: "failed",
} as const;

const ALL_TRACK_NAMES = [
  "idle",
  ...Object.keys(STATE_TRACKS),
  ...Object.keys(TRACK_ALIASES),
];

test("pet catalog: ports all eight built-in Codex pets in source order", () => {
  assert.equal(PETS.length, EXPECTED_CATALOG.length);
  PETS.forEach((pet, index) => {
    const [id, displayName, description] = EXPECTED_CATALOG[index];
    assert.equal(pet.id, id);
    assert.equal(pet.displayName, displayName);
    assert.equal(pet.description, description);
    assert.equal(pet.spritesheet, `/pets/${id}-spritesheet-v4.webp`);
  });
  assert.equal(DEFAULT_PET_ID, "codex");
});

test("pet catalog: every spritesheet asset and the license notice exist on disk", () => {
  const petsDir = path.join(process.cwd(), "public", "pets");
  for (const pet of PETS) {
    const file = path.join(petsDir, `${pet.id}-spritesheet-v4.webp`);
    assert.ok(fs.existsSync(file), `missing spritesheet ${file}`);
    const stats = fs.statSync(file);
    assert.ok(stats.size > 0, `spritesheet ${file} is empty`);
  }
  assert.ok(fs.existsSync(path.join(petsDir, "NOTICE.md")));
});

test("pet catalog: getPet resolves catalog ids and rejects disabled/unknown", () => {
  for (const pet of PETS) {
    assert.equal(getPet(pet.id)?.id, pet.id);
  }
  assert.equal(getPet(DISABLED_PET_ID), null);
  assert.equal(getPet("not-a-pet"), null);
  assert.equal(getPet(null), null);
  assert.equal(getPet(undefined), null);
});

test("pet animations: idle track matches the Rust idle_animation exactly", () => {
  for (const pet of PETS) {
    const idle = pet.animations.idle;
    assert.ok(idle, `${pet.id} has an idle track`);
    assert.deepEqual(
      idle.frames.map((frame) => [frame.sprite, frame.durationMs]),
      IDLE_FRAMES.map(([sprite, durationMs]) => [sprite, durationMs]),
      `${pet.id} idle frames`,
    );
    assert.equal(idle.loopStart, 0);
    assert.equal(idle.fallback, "idle");
  }
});

test("pet animations: every pet exposes the full built-in track set", () => {
  for (const pet of PETS) {
    for (const name of ALL_TRACK_NAMES) {
      assert.ok(pet.animations[name], `${pet.id} missing track ${name}`);
    }
  }
});

test("pet animations: state tracks mirror app_state_animation (3x row + idle tail)", () => {
  for (const pet of PETS) {
    for (const [name, spec] of Object.entries(STATE_TRACKS)) {
      const track = pet.animations[name];
      assert.ok(track, `${pet.id} missing track ${name}`);

      const primary: [number, number][] = [];
      for (let col = 0; col < spec.frames; col += 1) {
        primary.push([
          spec.row * 8 + col,
          col === spec.frames - 1 ? spec.finalMs : spec.durationMs,
        ]);
      }
      const expected = [
        ...primary,
        ...primary,
        ...primary,
        ...IDLE_FRAMES.map(([sprite, durationMs]) => [sprite, durationMs] as [number, number]),
      ];
      assert.deepEqual(
        track.frames.map((frame) => [frame.sprite, frame.durationMs]),
        expected,
        `${pet.id} track ${name}`,
      );
      assert.equal(track.loopStart, primary.length * 3, `${pet.id} track ${name} loopStart`);
      assert.equal(track.fallback, "idle", `${pet.id} track ${name} fallback`);
    }
  }
});

test("pet animations: aliases reuse the same track definition", () => {
  for (const pet of PETS) {
    for (const [alias, target] of Object.entries(TRACK_ALIASES)) {
      assert.deepEqual(pet.animations[alias], pet.animations[target], `${pet.id} alias ${alias}`);
    }
  }
});

test("pet animations: all sprite indices stay inside the 72-frame grid", () => {
  for (const pet of PETS) {
    for (const [name, track] of Object.entries(pet.animations)) {
      assert.ok(track.frames.length > 0, `${pet.id}/${name} must have frames`);
      for (const frame of track.frames) {
        assert.ok(
          frame.sprite >= 0 && frame.sprite < PET_FRAME_COUNT,
          `${pet.id}/${name} sprite ${frame.sprite} out of range`,
        );
      }
      assert.ok(pet.animations[track.fallback], `${pet.id}/${name} fallback ${track.fallback}`);
    }
  }
});

test("engine: first frame at t=0 with delay equal to its duration", () => {
  const pet = getPet("codex");
  assert.ok(pet);
  const tick = petSpriteAtMs(pet.animations.idle, 0);
  assert.deepEqual(tick, { sprite: 0, delayMs: 1680 });
});

test("engine: idle track loops from the start", () => {
  const pet = getPet("codex");
  assert.ok(pet);
  const idle = pet.animations.idle;
  const total = petAnimationTotalMs(idle);
  for (const at of [0, 500, 1690, 3000, total - 1]) {
    assert.deepEqual(petSpriteAtMs(idle, total + at), petSpriteAtMs(idle, at));
  }
});

test("engine: state tracks play the row 3x, then loop within the idle tail", () => {
  const pet = getPet("codex");
  assert.ok(pet);
  const waving = pet.animations.waving;
  const loopStart = waving.loopStart;
  assert.ok(loopStart !== null);
  const prefixMs = waving.frames
    .slice(0, loopStart)
    .reduce((sum, frame) => sum + frame.durationMs, 0);
  const loopMs = waving.frames
    .slice(loopStart)
    .reduce((sum, frame) => sum + frame.durationMs, 0);

  // During the prefix the row plays three times before any idle frame shows.
  assert.equal(petSpriteAtMs(waving, 0)?.sprite, 24); // row 3, col 0
  assert.equal(petSpriteAtMs(waving, prefixMs - 1)?.sprite, waving.frames[loopStart - 1].sprite);
  // Once in the tail, playback wraps within the tail only.
  for (const at of [0, 1000, loopMs - 1]) {
    assert.deepEqual(
      petSpriteAtMs(waving, prefixMs + loopMs + at),
      petSpriteAtMs(waving, prefixMs + at),
    );
  }
});

test("engine: one-shot animations hold their final frame", () => {
  const oneShot: PetAnimation = {
    frames: [
      { sprite: 10, durationMs: 100 },
      { sprite: 11, durationMs: 100 },
      { sprite: 12, durationMs: 100 },
    ],
    loopStart: null,
    fallback: "idle",
  };
  assert.deepEqual(petSpriteAtMs(oneShot, 0), { sprite: 10, delayMs: 100 });
  assert.deepEqual(petSpriteAtMs(oneShot, 250), { sprite: 12, delayMs: 50 });
  assert.deepEqual(petSpriteAtMs(oneShot, 300), { sprite: 12, delayMs: null });
  assert.deepEqual(petSpriteAtMs(oneShot, 9999), { sprite: 12, delayMs: null });
});

test("engine: single-frame animations never schedule another tick", () => {
  const single: PetAnimation = {
    frames: [{ sprite: 3, durationMs: 500 }],
    loopStart: 0,
    fallback: "idle",
  };
  assert.deepEqual(petSpriteAtMs(single, 0), { sprite: 3, delayMs: null });
  assert.deepEqual(petSpriteAtMs(single, 5000), { sprite: 3, delayMs: null });
});

test("engine: resolveActiveAnimation mirrors current_animation fallback rules", () => {
  const pet = getPet("codex");
  assert.ok(pet);

  // Unknown track names fall back to idle.
  assert.equal(resolveActiveAnimation(pet, "nope", 0), pet.animations.idle);
  // Looping tracks stay on themselves no matter how much time passes.
  assert.equal(resolveActiveAnimation(pet, "waving", 60_000), pet.animations.waving);

  // A finished one-shot hands off to its fallback track.
  const oneShotPet: PetDefinition = {
    ...pet,
    animations: {
      ...pet.animations,
      "gone-soon": {
        frames: [{ sprite: 1, durationMs: 50 }],
        loopStart: null,
        fallback: "idle",
      },
    },
  };
  assert.equal(resolveActiveAnimation(oneShotPet, "gone-soon", 0)?.frames[0].sprite, 1);
  assert.equal(resolveActiveAnimation(oneShotPet, "gone-soon", 51), oneShotPet.animations.idle);
});

test("component: PetSprite renderer exists and is wired to the ported model", () => {
  const componentPath = path.join(process.cwd(), "components", "pets", "PetSprite.tsx");
  assert.ok(fs.existsSync(componentPath), "components/pets/PetSprite.tsx should exist");
  const source = fs.readFileSync(componentPath, "utf8");
  assert.match(source, /"use client"/);
  assert.match(source, /@\/lib\/pets/);
  assert.match(source, /@\/lib\/pet-animation/);
  assert.match(source, /backgroundPosition/);
});
