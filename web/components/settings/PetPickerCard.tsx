'use client'

import { Ban, Check } from 'lucide-react'

import { PetSprite } from '@/components/pets/PetSprite'
import { DISABLED_PET_ID, type PetDefinition } from '@/lib/pets'

/**
 * One tile in the pet picker. Shows a live idle-loop preview of
 * the pet (or a "no pet" glyph for the disabled entry), mirroring the codex
 * `/pets` picker where the selected entry previews in place.
 */
export function PetPickerCard({
  pet,
  label,
  selected,
  onSelectAction,
}: {
  /** null renders the synthetic "disabled" entry. */
  pet: PetDefinition | null
  label: string
  selected: boolean
  onSelectAction: (id: string) => void
}) {
  const id = pet?.id ?? DISABLED_PET_ID
  return (
    <button
      type="button"
      onClick={() => onSelectAction(id)}
      aria-pressed={selected}
      className={`group relative flex flex-col items-stretch gap-2 rounded-xl border p-1.5 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
        selected
          ? 'border-[var(--foreground)] bg-[var(--card)] shadow-sm'
          : 'border-[var(--border)]/60 bg-transparent hover:border-[var(--border)] hover:bg-[var(--muted)]/25'
      }`}
    >
      <div
        className="relative flex items-center justify-center overflow-hidden rounded-lg bg-[var(--muted)]/40 ring-1 ring-[var(--border)]/50"
        style={{ aspectRatio: '1 / 1' }}
      >
        {pet ? (
          <PetSprite pet={pet} height={72} />
        ) : (
          <Ban className="h-7 w-7 text-[var(--muted-foreground)]/60" aria-hidden />
        )}
        {selected && (
          <div className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--foreground)] text-[var(--background)]">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </div>
        )}
      </div>
      <div className="px-1 pb-0.5">
        <span
          className={`text-[12.5px] tracking-tight ${
            selected
              ? 'font-medium text-[var(--foreground)]'
              : 'text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]'
          }`}
        >
          {label}
        </span>
      </div>
    </button>
  )
}
