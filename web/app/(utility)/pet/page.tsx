'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { Check, Flame, Gift, PawPrint, RotateCcw, Sparkles, Trophy } from 'lucide-react'

import { PetSprite } from '@/components/pets/PetSprite'
import { PetPickerCard } from '@/components/settings/PetPickerCard'
import { useAppShell } from '@/context/AppShellContext'
import { normalizePet } from '@/context/app-shell-storage'
import { persistUiSettingsPatch } from '@/components/settings/SettingsContext'
import {
  PET_MISSIONS,
  claimPetMission,
  claimedMissionIdsToday,
  petBadges,
  petGrowthAppearance,
  petLevelProgress,
  readPetGrowth,
  readPetGrowthServer,
  resetPetGrowth,
  subscribePetGrowth,
} from '@/lib/pet-growth'
import { DISABLED_PET_ID, PETS, getPet } from '@/lib/pets'

const SORTED_PETS = [...PETS].sort((a, b) => a.displayName.localeCompare(b.displayName))

function formatSignedXp(xp: number): string {
  return xp > 0 ? `+${xp}` : String(xp)
}

export default function PetGrowthPage() {
  const { language, pet, setPet } = useAppShell()
  const zh = language.toLowerCase().startsWith('zh')
  const tr = (zhText: string, enText: string) => (zh ? zhText : enText)
  const growth = useSyncExternalStore(subscribePetGrowth, readPetGrowth, readPetGrowthServer)
  const selectedPet = getPet(pet)
  const progress = useMemo(() => petLevelProgress(growth.xp), [growth.xp])
  const appearance = useMemo(() => petGrowthAppearance(growth.xp), [growth.xp])
  const claimed = useMemo(() => claimedMissionIdsToday(growth), [growth])
  const badges = useMemo(() => petBadges(growth), [growth])

  const selectPet = (id: string) => {
    const normalized = normalizePet(id)
    setPet(normalized)
    void persistUiSettingsPatch({ pet: normalized }).catch(error => {
      console.error('Failed to save pet preference:', error)
    })
  }

  const claimMission = (mission: (typeof PET_MISSIONS)[number]) => {
    claimPetMission({
      id: mission.id,
      label: tr(mission.labelZh, mission.labelEn),
      xp: mission.xp,
    })
  }

  const reset = () => {
    if (!window.confirm(tr('確定要重置寵物成長進度嗎？', 'Reset pet growth progress?'))) {
      return
    }
    resetPetGrowth()
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--background)]">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-amber-500/10 px-3 py-1 text-[12px] font-medium text-amber-700 dark:text-amber-300">
              <PawPrint size={14} />
              {tr('寵物養成', 'Pet care')}
            </div>
            <h1 className="font-serif text-[28px] font-semibold tracking-tight text-[var(--foreground)]">
              {tr('寵物中心', 'Pet Center')}
            </h1>
            <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-[var(--muted-foreground)]">
              {tr(
                '用 Pet XP 把每天學習變成養成遊戲：答題、複習和連續 Study Day 會讓寵物升級；答錯或缺席會扣一點 XP，讓孩子看見努力的回饋。',
                'Turn study into a growth loop with Pet XP: answers, review, and Study Day streaks level up the pet; wrong answers or missed days cost a little XP so effort has visible feedback.'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center gap-1.5 self-start rounded-lg border border-[var(--border)]/70 px-3 py-1.5 text-[12.5px] text-[var(--muted-foreground)] transition-colors hover:border-[var(--border)] hover:text-[var(--foreground)]"
          >
            <RotateCcw size={13} />
            {tr('重置進度', 'Reset progress')}
          </button>
        </header>

        <section className="grid gap-5 lg:grid-cols-[1.05fr_1fr]">
          <div className="rounded-3xl border border-[var(--border)]/70 bg-[var(--card)] p-5 shadow-sm">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <div
                className={`relative flex h-44 items-center justify-center overflow-hidden rounded-3xl bg-gradient-to-br ring-1 ring-[var(--border)]/50 sm:w-52 ${appearance.auraClassName}`}
              >
                {selectedPet ? (
                  <>
                    <div className="absolute inset-x-8 bottom-5 h-8 rounded-full bg-white/40 blur-xl dark:bg-white/10" />
                    <span className="absolute right-4 top-4 text-[28px] drop-shadow-sm" aria-hidden>
                      {appearance.badge}
                    </span>
                    <PetSprite
                      pet={selectedPet}
                      animation={progress.ratio > 0.85 ? 'jumping' : 'waving'}
                      height={appearance.height}
                      title={selectedPet.displayName}
                    />
                  </>
                ) : (
                  <PawPrint className="h-16 w-16 text-[var(--muted-foreground)]/40" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-[var(--muted-foreground)]">
                  {tr('目前夥伴', 'Current buddy')}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <h2 className="text-[24px] font-semibold tracking-tight text-[var(--foreground)]">
                    {selectedPet?.displayName ?? tr('尚未選擇', 'Not selected')}
                  </h2>
                  <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-[12px] font-medium text-amber-700 dark:text-amber-300">
                    {tr(appearance.labelZh, appearance.labelEn)}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--muted-foreground)]">
                  {selectedPet?.description ??
                    tr(
                      '選擇一隻寵物，讓它陪孩子一起完成每日任務。',
                      'Choose a pet to grow alongside daily study missions.'
                    )}
                </p>

                <div className="mt-5 grid grid-cols-3 gap-2">
                  <StatCard
                    icon={<Trophy size={15} />}
                    label={tr('等級', 'Level')}
                    value={String(progress.level)}
                  />
                  <StatCard
                    icon={<Sparkles size={15} />}
                    label="Pet XP"
                    value={String(growth.xp)}
                  />
                  <StatCard
                    icon={<Flame size={15} />}
                    label={tr('連續', 'Streak')}
                    value={tr(`${growth.streak} 天`, `${growth.streak}d`)}
                  />
                </div>

                <div className="mt-5">
                  <div className="mb-1.5 flex justify-between text-[12px] text-[var(--muted-foreground)]">
                    <span>{tr('距離下一級', 'Next level')}</span>
                    <span>
                      {tr(
                        `${progress.current}/${progress.needed} XP`,
                        `${progress.current}/${progress.needed} XP`
                      )}
                    </span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full bg-[var(--muted)]">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-amber-400 to-orange-500 transition-all"
                      style={{ width: `${progress.ratio * 100}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-[var(--border)]/70 bg-[var(--card)] p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <Gift size={18} className="text-amber-600 dark:text-amber-300" />
              <h2 className="text-[17px] font-semibold text-[var(--foreground)]">
                {tr('今日成長任務', "Today's growth missions")}
              </h2>
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
              {tr(
                '每項每天只能領取一次。實際做題提交也會自動記錄 Pet XP。',
                'Each can be claimed once per day. Quiz submissions also record Pet XP automatically.'
              )}
            </p>
            <div className="mt-4 space-y-2.5">
              {PET_MISSIONS.map(mission => {
                const done = claimed.includes(mission.id)
                return (
                  <button
                    key={mission.id}
                    type="button"
                    onClick={() => claimMission(mission)}
                    disabled={done}
                    className={`flex w-full items-center justify-between rounded-2xl border p-3 text-left transition-all ${
                      done
                        ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                        : 'border-[var(--border)]/70 hover:border-amber-500/40 hover:bg-amber-500/5'
                    }`}
                  >
                    <span>
                      <span className="block text-[13.5px] font-medium text-[var(--foreground)]">
                        {tr(mission.labelZh, mission.labelEn)}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-[var(--muted-foreground)]">
                        {tr(
                          `${formatSignedXp(mission.xp)} Pet XP`,
                          `${formatSignedXp(mission.xp)} Pet XP`
                        )}
                      </span>
                    </span>
                    {done ? <Check size={18} /> : <Sparkles size={18} />}
                  </button>
                )
              })}
            </div>
          </div>
        </section>

        <section className="mt-5 grid gap-5 lg:grid-cols-[1fr_0.75fr]">
          <div className="rounded-3xl border border-[var(--border)]/70 bg-[var(--card)] p-5 shadow-sm">
            <h2 className="text-[17px] font-semibold text-[var(--foreground)]">
              {tr('選擇陪伴寵物', 'Choose companion pet')}
            </h2>
            <p className="mt-1 text-[12.5px] text-[var(--muted-foreground)]">
              {tr(
                '外觀設定中的寵物選擇已移到這裡，成長與換寵物在同一頁完成。',
                'The pet picker from Appearance now lives here with growth controls.'
              )}
            </p>
            <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-5">
              <PetPickerCard
                pet={null}
                label={tr('關閉', 'Disabled')}
                selected={pet === DISABLED_PET_ID}
                onSelectAction={selectPet}
              />
              {SORTED_PETS.map(option => (
                <PetPickerCard
                  key={option.id}
                  pet={option}
                  label={option.displayName}
                  selected={pet === option.id}
                  onSelectAction={selectPet}
                />
              ))}
            </div>
          </div>

          <div className="space-y-5">
            <div className="rounded-3xl border border-[var(--border)]/70 bg-[var(--card)] p-5 shadow-sm">
              <h2 className="text-[17px] font-semibold text-[var(--foreground)]">
                {tr('成就徽章', 'Achievements')}
              </h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {badges.length > 0 ? (
                  badges.map(badge => (
                    <span
                      key={badge}
                      className="rounded-full bg-amber-500/10 px-3 py-1 text-[12px] font-medium text-amber-700 dark:text-amber-300"
                    >
                      {badge}
                    </span>
                  ))
                ) : (
                  <p className="text-[12.5px] text-[var(--muted-foreground)]">
                    {tr(
                      '先拿到 80 XP，寵物就會獲得第一個升級徽章。',
                      'Reach 80 XP to unlock the first level-up badge.'
                    )}
                  </p>
                )}
              </div>
            </div>

            <div className="rounded-3xl border border-[var(--border)]/70 bg-[var(--card)] p-5 shadow-sm">
              <h2 className="text-[17px] font-semibold text-[var(--foreground)]">
                {tr('最近記錄', 'Recent activity')}
              </h2>
              <div className="mt-3 space-y-2">
                {growth.recent.length > 0 ? (
                  growth.recent.map(item => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-xl bg-[var(--muted)]/35 px-3 py-2 text-[12.5px]"
                    >
                      <span className="min-w-0 truncate text-[var(--foreground)]">
                        {item.label}
                      </span>
                      <span
                        className={
                          item.xp >= 0
                            ? 'text-emerald-600 dark:text-emerald-300'
                            : 'text-rose-600 dark:text-rose-300'
                        }
                      >
                        {tr(`${formatSignedXp(item.xp)} XP`, `${formatSignedXp(item.xp)} XP`)}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-[12.5px] text-[var(--muted-foreground)]">
                    {tr('完成一個任務開始養成。', 'Complete a mission to start growing.')}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-[var(--muted)]/35 p-3">
      <div className="mb-1 text-[var(--muted-foreground)]">{icon}</div>
      <div className="text-[18px] font-semibold leading-none text-[var(--foreground)]">{value}</div>
      <div className="mt-1 text-[11px] text-[var(--muted-foreground)]">{label}</div>
    </div>
  )
}
