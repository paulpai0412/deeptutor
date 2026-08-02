"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  FileText,
  Loader2,
  Plus,
  Settings as SettingsIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import Modal from "@/components/common/Modal";
import PaperLibraryPapersTab from "./PaperLibraryPapersTab";
import PaperLibraryUploadSection from "./PaperLibraryUploadSection";
import {
  createPaperLibrary,
  deletePaperLibrary,
  getPaperLibraryOptions,
  listPaperLibraries,
  updatePaperLibrary,
  type PaperLibraryOptions,
  type PaperLibrarySummary,
} from "@/lib/knowledge-api";

const DETAIL_SECTIONS = [
  ["papers", "Files", FileText],
  ["add", "Add files", Plus],
  ["settings", "Settings", SettingsIcon],
] as const;
type DetailSection = (typeof DETAIL_SECTIONS)[number][0];

function parseSection(value: string | null): DetailSection {
  return DETAIL_SECTIONS.some(([section]) => section === value)
    ? (value as DetailSection)
    : "papers";
}

export default function PaperLibrariesHome() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialLibraryId =
    searchParams.get("library") ?? searchParams.get("library_id");

  const [libraries, setLibraries] = useState<PaperLibrarySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialLibraryId);
  const [view, setView] = useState<"home" | "detail">(
    initialLibraryId ? "detail" : "home",
  );
  const [section, setSection] = useState<DetailSection>(
    parseSection(searchParams.get("section")),
  );
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [options, setOptions] = useState<PaperLibraryOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [libraryName, setLibraryName] = useState("");
  const [libraryDescription, setLibraryDescription] = useState("");
  const [parserEngine, setParserEngine] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [failurePolicy, setFailurePolicy] = useState("keep_partial");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const urlInitialized = useRef(false);

  const selected = useMemo(
    () => libraries.find((library) => library.library_id === selectedId) ?? null,
    [libraries, selectedId],
  );

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const next = await listPaperLibraries({ force: true });
      setLibraries(next);
      setSelectedId((current) =>
        current && next.some((library) => library.library_id === current)
          ? current
          : initialLibraryId &&
              next.some((library) => library.library_id === initialLibraryId)
            ? initialLibraryId
            : null,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [initialLibraryId]);

  useEffect(() => {
    void load();
    void getPaperLibraryOptions()
      .then(setOptions)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setOptionsLoading(false));
  }, [load]);

  useEffect(() => {
    if (loading || !selectedId) return;
    if (libraries.some((library) => library.library_id === selectedId)) return;
    setSelectedId(null);
    setView("home");
  }, [libraries, loading, selectedId]);

  useEffect(() => {
    const nextLibrary = view === "detail" ? selectedId : null;
    const nextSection = view === "detail" ? section : null;
    const currentLibrary = searchParams.get("library");
    const currentSection = searchParams.get("section");
    const hasLegacyLibrary = searchParams.has("library_id");
    const hasPaperState =
      searchParams.has("paper") || searchParams.has("review");
    if (
      currentLibrary === nextLibrary &&
      currentSection === nextSection &&
      !hasLegacyLibrary &&
      !(view === "home" && hasPaperState)
    ) {
      urlInitialized.current = true;
      return;
    }

    const params = new URLSearchParams(searchParams.toString());
    if (nextLibrary) params.set("library", nextLibrary);
    else params.delete("library");
    params.delete("library_id");
    if (nextSection) params.set("section", nextSection);
    else params.delete("section");
    if (view === "home") {
      params.delete("paper");
      params.delete("review");
      params.delete("folder");
    }
    const search = params.toString();
    const nextUrl = `${pathname}${search ? `?${search}` : ""}`;
    if (urlInitialized.current) {
      router.push(nextUrl, { scroll: false });
    } else {
      router.replace(nextUrl, { scroll: false });
    }
    urlInitialized.current = true;
  }, [pathname, router, searchParams, section, selectedId, view]);

  useEffect(() => {
    const settings = selected?.settings ?? {};
    const selection = settings.llm_selection;
    setLibraryName(selected?.name ?? "");
    setLibraryDescription(selected?.description ?? "");
    setParserEngine(
      typeof settings.parser_engine === "string" ? settings.parser_engine : "",
    );
    setFailurePolicy(
      typeof settings.failure_policy === "string"
        ? settings.failure_policy
        : "keep_partial",
    );
    setLlmKey(
      selection && typeof selection === "object"
        ? `${String((selection as Record<string, unknown>).profile_id ?? "")}:${String((selection as Record<string, unknown>).model_id ?? "")}`
        : "",
    );
  }, [selected]);

  const openCreate = useCallback(() => {
    setCreateName("");
    setCreateDescription("");
    setError(null);
    setCreateOpen(true);
  }, []);

  const openLibrary = useCallback((libraryId: string) => {
    setSelectedId(libraryId);
    setSection("papers");
    setView("detail");
  }, []);

  const backToOverview = useCallback(() => {
    setSelectedId(null);
    setView("home");
  }, []);

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createPaperLibrary({
        name: createName.trim(),
        description: createDescription.trim(),
      });
      setLibraries((current) => [...current, created]);
      setSelectedId(created.library_id);
      setSection("papers");
      setView("detail");
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  }, [createDescription, createName]);

  const handleDeleteLibrary = useCallback(async () => {
    if (!selected) return;
    if (
      !window.confirm(
        t('Delete Paper Library "{{name}}"?', { name: selected.name }),
      )
    ) {
      return;
    }
    setError(null);
    try {
      await deletePaperLibrary(selected.library_id);
      setLibraries((current) =>
        current.filter((library) => library.library_id !== selected.library_id),
      );
      backToOverview();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [backToOverview, selected, t]);

  const handleSaveSettings = useCallback(async () => {
    if (!selected) return;
    setSettingsSaving(true);
    setSettingsNotice(null);
    setError(null);
    try {
      const [profileId, modelId] = llmKey.split(":");
      const updated = await updatePaperLibrary(selected.library_id, {
        name: libraryName.trim(),
        description: libraryDescription.trim(),
        settings: {
          parser_engine: parserEngine,
          failure_policy: failurePolicy,
          llm_selection:
            profileId && modelId
              ? { profile_id: profileId, model_id: modelId }
              : null,
        },
      });
      setLibraries((current) =>
        current.map((library) =>
          library.library_id === updated.library_id ? updated : library,
        ),
      );
      setSettingsNotice(t("Settings saved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSettingsNotice(null);
    } finally {
      setSettingsSaving(false);
    }
  }, [
    failurePolicy,
    libraryDescription,
    libraryName,
    llmKey,
    parserEngine,
    selected,
    t,
  ]);

  const filteredLibraries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return libraries;
    return libraries.filter(
      (library) =>
        library.name.toLowerCase().includes(needle) ||
        library.description?.toLowerCase().includes(needle),
    );
  }, [libraries, query]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--background)]">
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
        >
          <span className="truncate">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded-md px-2 py-0.5 text-[11.5px] font-medium hover:bg-red-100 dark:hover:bg-red-950/50"
          >
            {t("Dismiss")}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--muted-foreground)]" />
        </div>
      ) : view === "detail" && selected ? (
        <PaperLibraryDetail
          library={selected}
          libraries={libraries}
          section={section}
          onSectionChange={setSection}
          onBack={backToOverview}
          onRefresh={() => load(false)}
          onDelete={handleDeleteLibrary}
          options={options}
          optionsLoading={optionsLoading}
          libraryName={libraryName}
          libraryDescription={libraryDescription}
          parserEngine={parserEngine}
          llmKey={llmKey}
          failurePolicy={failurePolicy}
          settingsSaving={settingsSaving}
          settingsNotice={settingsNotice}
          onLibraryNameChange={setLibraryName}
          onLibraryDescriptionChange={setLibraryDescription}
          onParserChange={setParserEngine}
          onLlmChange={setLlmKey}
          onFailurePolicyChange={setFailurePolicy}
          onSaveSettings={handleSaveSettings}
        />
      ) : (
        <PaperLibraryOverview
          libraries={filteredLibraries}
          total={libraries.length}
          query={query}
          onQueryChange={setQuery}
          onCreate={openCreate}
          onOpen={openLibrary}
        />
      )}

      <Modal
        isOpen={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("New Paper Library")}
        titleIcon={<BookOpen className="h-4 w-4" />}
        width="sm"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating || !createName.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {creating && <Loader2 size={13} className="animate-spin" />}
              {t("Create")}
            </button>
          </div>
        }
      >
        <form
          className="space-y-3 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <label className="block text-[11px] text-[var(--muted-foreground)]">
            {t("Library name")}
            <input
              data-autofocus
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              maxLength={120}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--ring)]"
            />
          </label>
          <label className="block text-[11px] text-[var(--muted-foreground)]">
            {t("Description (optional)")}
            <textarea
              value={createDescription}
              onChange={(event) => setCreateDescription(event.target.value)}
              maxLength={500}
              rows={3}
              className="mt-1 w-full resize-none rounded-md border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--ring)]"
            />
          </label>
        </form>
      </Modal>
    </div>
  );
}

function PaperLibraryOverview({
  libraries,
  total,
  query,
  onQueryChange,
  onCreate,
  onOpen,
}: {
  libraries: PaperLibrarySummary[];
  total: number;
  query: string;
  onQueryChange: (value: string) => void;
  onCreate: () => void;
  onOpen: (libraryId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 overflow-y-auto bg-[var(--background)]">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[19px] font-semibold tracking-tight text-[var(--foreground)]">
              {t("Paper Libraries")}
            </h1>
            <p className="mt-1 text-[12.5px] text-[var(--muted-foreground)]">
              {t("Organize private exam files for Exams.")}
            </p>
          </div>
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-2 text-[12.5px] font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90"
          >
            <Plus size={14} />
            {t("New Paper Library")}
          </button>
        </div>

        <section className="mt-8 pb-2">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              <BookOpen className="h-3.5 w-3.5" />
              {t("Paper Libraries")}
              <span className="rounded-full bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                {total}
              </span>
            </h2>
            {total > 6 && (
              <input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={t("Search Paper Libraries…")}
                className="w-52 rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-[12px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:border-[var(--foreground)]/25"
              />
            )}
          </div>

          {total === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-12 text-center">
              <BookOpen className="mx-auto mb-2 h-6 w-6 text-[var(--muted-foreground)]" />
              <div className="text-[13px] font-medium text-[var(--foreground)]">
                {t("No Paper Libraries yet")}
              </div>
              <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-[var(--muted-foreground)]">
                {t("Create a library before uploading files.")}
              </p>
              <button
                type="button"
                onClick={onCreate}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-2 text-[12.5px] font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90"
              >
                <Plus size={14} />
                {t("New Paper Library")}
              </button>
            </div>
          ) : libraries.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-[12px] text-[var(--muted-foreground)]">
              {t("No matches")}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {libraries.map((library) => (
                <button
                  key={library.library_id}
                  type="button"
                  onClick={() => onOpen(library.library_id)}
                  className="group flex flex-col gap-2 rounded-2xl border border-[var(--border)] p-4 text-left transition-colors hover:border-[var(--ring)]"
                >
                  <div className="flex items-center gap-2">
                    <BookOpen className="h-4 w-4 shrink-0 text-[var(--primary)]" />
                    <span className="truncate text-[13.5px] font-medium text-[var(--foreground)]">
                      {library.name}
                    </span>
                  </div>
                  {library.description && (
                    <p className="line-clamp-2 text-[11.5px] leading-snug text-[var(--muted-foreground)]">
                      {library.description}
                    </p>
                  )}
                  <div className="mt-auto flex items-center gap-2 pt-1 text-[11px] text-[var(--muted-foreground)]">
                    <span className="rounded-full border border-[var(--border)] px-1.5 py-0.5">
                      {library.paper_count} {t("files")}
                    </span>
                    <span className="ml-auto inline-flex items-center gap-1 text-[var(--primary)] opacity-0 transition-opacity group-hover:opacity-100">
                      {t("Open")}
                      <ArrowLeft className="h-3.5 w-3.5 rotate-180" />
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function PaperLibraryDetail({
  library,
  libraries,
  section,
  onSectionChange,
  onBack,
  onRefresh,
  onDelete,
  options,
  optionsLoading,
  libraryName,
  libraryDescription,
  parserEngine,
  llmKey,
  failurePolicy,
  settingsSaving,
  settingsNotice,
  onLibraryNameChange,
  onLibraryDescriptionChange,
  onParserChange,
  onLlmChange,
  onFailurePolicyChange,
  onSaveSettings,
}: {
  library: PaperLibrarySummary;
  libraries: PaperLibrarySummary[];
  section: DetailSection;
  onSectionChange: (section: DetailSection) => void;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onDelete: () => Promise<void>;
  options: PaperLibraryOptions | null;
  optionsLoading: boolean;
  libraryName: string;
  libraryDescription: string;
  parserEngine: string;
  llmKey: string;
  failurePolicy: string;
  settingsSaving: boolean;
  onLibraryNameChange: (value: string) => void;
  onLibraryDescriptionChange: (value: string) => void;
  onParserChange: (value: string) => void;
  onLlmChange: (value: string) => void;
  onFailurePolicyChange: (value: string) => void;
  onSaveSettings: () => Promise<void>;
  settingsNotice: string | null;
}) {
  const { t } = useTranslation();
  return (
    <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[var(--background)]">
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--card)] px-6 py-4">
        <button
          type="button"
          onClick={onBack}
          className="mb-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t("Paper Libraries")}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate font-serif text-[18px] font-semibold tracking-tight text-[var(--foreground)]">
            {library.name}
          </h1>
          <span className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] text-[var(--muted-foreground)]">
            {library.paper_count} {t("files")}
          </span>
        </div>
        {library.description && (
          <p className="mt-1 text-[12px] text-[var(--muted-foreground)]">
            {library.description}
          </p>
        )}
        <nav className="-mb-3 mt-3 flex gap-1 overflow-x-auto" aria-label={t("Paper Library sections")}>
          {DETAIL_SECTIONS.map(([key, label, Icon]) => {
            const active = section === key;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSectionChange(key)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-t-md px-3 py-2 text-[12.5px] font-medium transition-colors ${
                  active
                    ? "border-b-2 border-[var(--primary)] text-[var(--foreground)]"
                    : "border-b-2 border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
              >
                <Icon size={13} />
                {t(label)}
              </button>
            );
          })}
        </nav>
      </div>

      <div
        className={`min-h-0 flex-1 ${
          section === "papers" ? "overflow-hidden" : "overflow-y-auto px-6 py-5"
        }`}
      >
        <div
          className={
            section === "papers" ? "h-full" : "mx-auto w-full max-w-3xl"
          }
        >
          {section === "papers" && (
            <PaperLibraryPapersTab
              key={library.library_id}
              libraryId={library.library_id}
              libraries={libraries}
            />
          )}
          {section === "add" && (
            <PaperLibraryUploadSection
              libraryId={library.library_id}
              onUploaded={onRefresh}
            />
          )}
          {section === "settings" && (
            <PaperLibrarySettingsSection
              library={library}
              options={options}
              optionsLoading={optionsLoading}
              libraryName={libraryName}
              libraryDescription={libraryDescription}
              parserEngine={parserEngine}
              llmKey={llmKey}
              failurePolicy={failurePolicy}
              settingsSaving={settingsSaving}
              settingsNotice={settingsNotice}
              onLibraryNameChange={onLibraryNameChange}
              onLibraryDescriptionChange={onLibraryDescriptionChange}
              onParserChange={onParserChange}
              onLlmChange={onLlmChange}
              onFailurePolicyChange={onFailurePolicyChange}
              onSaveSettings={onSaveSettings}
              onDelete={onDelete}
            />
          )}
        </div>
      </div>
    </main>
  );
}

function PaperLibrarySettingsSection({
  library,
  options,
  optionsLoading,
  libraryName,
  libraryDescription,
  parserEngine,
  llmKey,
  failurePolicy,
  settingsSaving,
  settingsNotice,
  onLibraryNameChange,
  onLibraryDescriptionChange,
  onParserChange,
  onLlmChange,
  onFailurePolicyChange,
  onSaveSettings,
  onDelete,
}: {
  library: PaperLibrarySummary;
  options: PaperLibraryOptions | null;
  optionsLoading: boolean;
  libraryName: string;
  libraryDescription: string;
  parserEngine: string;
  llmKey: string;
  failurePolicy: string;
  settingsSaving: boolean;
  onLibraryNameChange: (value: string) => void;
  onLibraryDescriptionChange: (value: string) => void;
  onParserChange: (value: string) => void;
  onLlmChange: (value: string) => void;
  onFailurePolicyChange: (value: string) => void;
  onSaveSettings: () => Promise<void>;
  onDelete: () => Promise<void>;
  settingsNotice: string | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h2 className="text-[13px] font-medium text-[var(--foreground)]">
            {t("Paper Library settings")}
          </h2>
          <p className="mt-0.5 text-[11.5px] text-[var(--muted-foreground)]">
            {t("Settings apply to new uploads and explicit retries.")}
          </p>
          {settingsNotice && (
            <p role="status" className="mt-2 text-[11.5px] text-emerald-700 dark:text-emerald-300">
              {settingsNotice}
            </p>
          )}
        </div>
        <div className="grid gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 sm:grid-cols-2">
          <label className="text-[10.5px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            {t("Library name")}
            <input
              value={libraryName}
              onChange={(event) => onLibraryNameChange(event.target.value)}
              maxLength={120}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-2 text-[12.5px] normal-case tracking-normal text-[var(--foreground)] outline-none focus:border-[var(--ring)]"
            />
          </label>
          <label className="text-[10.5px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            {t("Description")}
            <textarea
              value={libraryDescription}
              onChange={(event) => onLibraryDescriptionChange(event.target.value)}
              maxLength={500}
              rows={2}
              className="mt-1 w-full resize-none rounded-md border border-[var(--border)] bg-[var(--card)] px-2.5 py-2 text-[12.5px] normal-case tracking-normal text-[var(--foreground)] outline-none focus:border-[var(--ring)]"
            />
          </label>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[12.5px] font-medium text-[var(--foreground)]">
              {t("Extraction settings")}
            </div>
            <p className="mt-0.5 text-[11.5px] text-[var(--muted-foreground)]">
              {t("Structured paper extraction requires an LLM.")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onSaveSettings()}
            disabled={settingsSaving || optionsLoading || !libraryName.trim()}
            className="rounded-md bg-[var(--primary)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
          >
            {settingsSaving ? t("Saving...") : t("Save settings")}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-[11px] text-[var(--muted-foreground)]">
            {t("Extraction LLM")}
            <select
              aria-label={t("Extraction LLM")}
              value={llmKey}
              onChange={(event) => onLlmChange(event.target.value)}
              disabled={optionsLoading}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[12px] text-[var(--foreground)]"
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
              aria-label={t("PDF parser")}
              value={parserEngine}
              onChange={(event) => onParserChange(event.target.value)}
              disabled={optionsLoading}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[12px] text-[var(--foreground)]"
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
          <label className="text-[11px] text-[var(--muted-foreground)]">
            {t("Failure policy")}
            <select
              aria-label={t("Failure policy")}
              value={failurePolicy}
              onChange={(event) => onFailurePolicyChange(event.target.value)}
              disabled={optionsLoading}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[12px] text-[var(--foreground)]"
            >
              {(options?.failure_policies ?? [
                { id: "keep_partial", label: "Keep usable questions" },
              ]).map((policy) => (
                <option key={policy.id} value={policy.id}>
                  {policy.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-red-200 bg-red-50/40 p-3 dark:border-red-900/60 dark:bg-red-950/15">
        <div>
          <div className="text-[12.5px] font-medium text-red-700 dark:text-red-300">
            {t("Danger zone")}
          </div>
          <p className="mt-0.5 text-[11.5px] text-red-700/80 dark:text-red-300/80">
            {t("Deleting a Paper Library permanently removes its live files.")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void onDelete()}
          className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-red-50 px-2.5 py-1.5 text-[12px] font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300 dark:hover:bg-red-950/50"
        >
          {t("Delete Paper Library")}
        </button>
      </section>
    </div>
  );
}
