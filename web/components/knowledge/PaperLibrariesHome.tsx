"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import PaperLibraryPanel from "@/components/space/PaperLibraryPanel";
import {
  createPaperLibrary,
  deletePaperLibrary,
  getPaperLibraryOptions,
  listPaperLibraries,
  updatePaperLibrary,
  type PaperLibraryOptions,
  type PaperLibrarySummary,
} from "@/lib/knowledge-api";

export default function PaperLibrariesHome() {
  const { t } = useTranslation();
  const [libraries, setLibraries] = useState<PaperLibrarySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<PaperLibraryOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [parserEngine, setParserEngine] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);

  const selected = useMemo(
    () => libraries.find((library) => library.library_id === selectedId) ?? null,
    [libraries, selectedId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await listPaperLibraries({ force: true });
      setLibraries(next);
      setSelectedId((current) =>
        current && next.some((library) => library.library_id === current)
          ? current
          : null,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void getPaperLibraryOptions()
      .then(setOptions)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setOptionsLoading(false));
  }, [load]);

  useEffect(() => {
    const settings = selected?.settings ?? {};
    const selection = settings.llm_selection;
    setParserEngine(typeof settings.parser_engine === "string" ? settings.parser_engine : "");
    setLlmKey(
      selection && typeof selection === "object"
        ? `${String((selection as Record<string, unknown>).profile_id ?? "")}:${String((selection as Record<string, unknown>).model_id ?? "")}`
        : "",
    );
  }, [selected]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createPaperLibrary({
        name: name.trim(),
        description: description.trim(),
      });
      setLibraries((current) => [...current, created]);
      setSelectedId(created.library_id);
      setName("");
      setDescription("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }, [description, name]);

  const handleDeleteLibrary = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(t('Delete Paper Library "{{name}}"?', { name: selected.name }))) {
      return;
    }
    setError(null);
    try {
      await deletePaperLibrary(selected.library_id);
      setLibraries((current) =>
        current.filter((library) => library.library_id !== selected.library_id),
      );
      setSelectedId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [selected, t]);

  const handleSaveSettings = useCallback(async () => {
    if (!selected) return;
    setSettingsSaving(true);
    setError(null);
    try {
      const [profileId, modelId] = llmKey.split(":");
      const updated = await updatePaperLibrary(selected.library_id, {
        settings: {
          parser_engine: parserEngine,
          failure_policy: "keep_partial",
          llm_selection:
            profileId && modelId ? { profile_id: profileId, model_id: modelId } : null,
        },
      });
      setLibraries((current) =>
        current.map((library) =>
          library.library_id === updated.library_id ? updated : library,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSettingsSaving(false);
    }
  }, [llmKey, parserEngine, selected]);

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto bg-[var(--background)]">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight text-[var(--foreground)]">
              {t("Paper Libraries")}
            </h1>
            <p className="mt-1 text-[12.5px] text-[var(--muted-foreground)]">
              {t("Organize private exam papers for Exams.")}
            </p>
          </div>
          <BookOpen className="h-5 w-5 text-[var(--muted-foreground)]" />
        </div>

        {error ? (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
            {error}
          </div>
        ) : null}

        <div className="mt-6 grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="space-y-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                {t("Create Paper Library")}
              </div>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("Library name")}
                maxLength={120}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--ring)]"
              />
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={t("Description (optional)")}
                maxLength={500}
                rows={2}
                className="mt-2 w-full resize-none rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--ring)]"
              />
              <button
                type="button"
                onClick={() => void handleCreate()}
                disabled={creating || !name.trim()}
                className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-2 text-[12px] font-medium text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                {t("Create")}
              </button>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-2">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                {t("Libraries")}
              </div>
              {loading ? (
                <div className="flex justify-center px-2 py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--muted-foreground)]" />
                </div>
              ) : libraries.length === 0 ? (
                <p className="px-2 py-5 text-[12px] text-[var(--muted-foreground)]">
                  {t("No Paper Libraries yet")}
                </p>
              ) : (
                <div className="space-y-1">
                  {libraries.map((library) => (
                    <button
                      key={library.library_id}
                      type="button"
                      onClick={() => setSelectedId(library.library_id)}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-[12px] transition-colors ${
                        selectedId === library.library_id
                          ? "bg-[var(--primary)]/10 text-[var(--primary)]"
                          : "text-[var(--foreground)] hover:bg-[var(--muted)]/50"
                      }`}
                    >
                      <span className="min-w-0 truncate">{library.name}</span>
                      <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">
                        {library.paper_count}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </aside>

          <main className="min-w-0">
            {selected ? (
              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-[15px] font-semibold text-[var(--foreground)]">
                      {selected.name}
                    </h2>
                    {selected.description ? (
                      <p className="mt-1 truncate text-[11px] text-[var(--muted-foreground)]">
                        {selected.description}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="rounded-full bg-[var(--muted)] px-2 py-1 text-[10px] text-[var(--muted-foreground)]">
                      {selected.paper_count} {t("papers")}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleDeleteLibrary()}
                      className="rounded-md border border-red-200 px-2 py-1 text-[10px] font-medium text-red-700 hover:bg-red-50 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-950/30"
                    >
                      {t("Delete library")}
                    </button>
                  </div>
                </div>
                <div className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-[12px] font-semibold text-[var(--foreground)]">
                        {t("Extraction settings")}
                      </h3>
                      <p className="mt-0.5 text-[10.5px] text-[var(--muted-foreground)]">
                        {t("Structured paper extraction requires an LLM.")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleSaveSettings()}
                      disabled={settingsSaving || optionsLoading}
                      className="rounded-md bg-[var(--primary)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
                    >
                      {settingsSaving ? t("Saving...") : t("Save settings")}
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-[11px] text-[var(--muted-foreground)]">
                      {t("Extraction LLM")}
                      <select
                        value={llmKey}
                        onChange={(event) => setLlmKey(event.target.value)}
                        disabled={optionsLoading}
                        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[12px] text-[var(--foreground)]"
                      >
                        <option value="">
                          {optionsLoading ? t("Loading...") : t("Use active LLM")}
                        </option>
                        {(options?.llm.options ?? []).map((option) => (
                          <option
                            key={`${option.profile_id}:${option.model_id}`}
                            value={`${option.profile_id}:${option.model_id}`}
                          >
                            {option.profile_name} · {option.model_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="text-[11px] text-[var(--muted-foreground)]">
                      {t("PDF parser")}
                      <select
                        value={parserEngine}
                        onChange={(event) => setParserEngine(event.target.value)}
                        disabled={optionsLoading}
                        className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[12px] text-[var(--foreground)]"
                      >
                        <option value="">{t("System default")}</option>
                        {(options?.parsers ?? [])
                          .filter((parser) => parser.available)
                          .map((parser) => (
                            <option key={parser.id} value={parser.id}>
                              {parser.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                </div>
                <PaperLibraryPanel
                  libraryId={selected.library_id}
                  libraries={libraries}
                />
              </div>
            ) : (
              <div className="flex min-h-[360px] items-center justify-center rounded-xl border border-dashed border-[var(--border)] px-6 text-center">
                <div>
                  <BookOpen className="mx-auto mb-2 h-7 w-7 text-[var(--muted-foreground)]" />
                  <p className="text-[13px] font-medium text-[var(--foreground)]">
                    {t("Select a Paper Library")}
                  </p>
                  <p className="mt-1 text-[12px] text-[var(--muted-foreground)]">
                    {t("Create a library before uploading papers.")}
                  </p>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
