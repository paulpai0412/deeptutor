"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, ChevronDown, Database } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLingerExpand } from "@/hooks/use-linger-expand";

/**
 * Persistent scope selector in the composer toolbar.
 *
 * Knowledge mode exposes the session-level KB dropdown. Exam mode reuses
 * the same compact chip as a Paper Library affordance that opens the
 * right-side Exam settings card.
 *
 * Multi-select: knowledge rows toggle without closing, so several bases can
 * be picked in one pass. A non-empty selection tints the icon primary so the
 * active scope stays visible even when the chip is collapsed.
 */
export default function KnowledgeSelector({
  knowledgeBases,
  selected,
  onToggle,
  placement = "top",
  scope = "knowledge",
  onPaperLibraryClick,
}: {
  knowledgeBases: { name: string }[];
  selected: string[];
  onToggle: (name: string) => void;
  placement?: "top" | "bottom";
  scope?: "knowledge" | "paper";
  onPaperLibraryClick?: () => void;
}) {
  const { t } = useTranslation();
  const isPaperLibrary = scope === "paper";
  const ScopeIcon = isPaperLibrary ? BookOpen : Database;
  const [open, setOpenState] = useState(false);
  const { expanded, linger, triggerProps: lingerProps } = useLingerExpand(open);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    // Keep the label expanded for a beat after close so a just-made
    // change registers before the chip collapses.
    if (!next) linger();
  };
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const count = selected.length;
  const label = isPaperLibrary
    ? t("Paper Library")
    : count === 0
      ? t("Knowledge")
      : count === 1
        ? selected[0]
        : `${count} ${t("knowledge bases")}`;
  const menuPlacementClass =
    placement === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5";

  return (
    <div ref={rootRef} className="relative">
      {/* Resting state is just the database icon; hovering (or opening
          the menu) slides the scope label out and lingers ~1.2s after
          leave/selection before collapsing. A non-empty scope tints the
          icon primary. */}
      <button
        type="button"
        onClick={() => {
          if (isPaperLibrary) {
            onPaperLibraryClick?.();
            return;
          }
          setOpen(!open);
        }}
        aria-label={
          isPaperLibrary ? t("Paper Library") : t("Select knowledge bases")
        }
        aria-expanded={isPaperLibrary ? undefined : open}
        {...lingerProps}
        className={`inline-flex h-8 shrink-0 items-center rounded-lg px-2 text-[14px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97] ${
          open
            ? "bg-[var(--muted)] text-[var(--foreground)]"
            : count > 0
              ? "text-[var(--primary)] hover:bg-[var(--primary)]/[0.07]"
              : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
        }`}
      >
        <ScopeIcon size={16} strokeWidth={1.7} className="shrink-0" />
        <span
          className={`flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap transition-[max-width,opacity,margin-left] duration-300 ease-out ${
            expanded
              ? "ml-1.5 max-w-[160px] opacity-100"
              : "ml-0 max-w-0 opacity-0"
          }`}
        >
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown
            size={13}
            className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {!isPaperLibrary && open && (
        <div
          className={`dt-popup-up absolute right-0 z-50 ${menuPlacementClass} w-[min(280px,calc(100vw-32px))] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover)] shadow-lg backdrop-blur-md`}
        >
          {knowledgeBases.length === 0 ? (
            <div className="px-3 py-4 text-center text-[12px] text-[var(--muted-foreground)]">
              {t("No knowledge bases available")}
            </div>
          ) : (
            <div className="max-h-[280px] overflow-y-auto py-1">
              {knowledgeBases.map((kb) => {
                const active = selected.includes(kb.name);
                return (
                  <button
                    key={kb.name}
                    type="button"
                    onClick={() => onToggle(kb.name)}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors active:bg-[var(--muted)]/70 ${
                      active
                        ? "bg-[var(--primary)]/[0.06]"
                        : "hover:bg-[var(--muted)]/45"
                    }`}
                  >
                    <ScopeIcon
                      size={15}
                      strokeWidth={1.7}
                      className={`shrink-0 ${
                        active
                          ? "text-[var(--primary)]"
                          : "text-[var(--muted-foreground)]"
                      }`}
                    />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--foreground)]">
                      {kb.name}
                    </span>
                    {active && (
                      <Check
                        size={14}
                        strokeWidth={2}
                        className="shrink-0 text-[var(--primary)]"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
