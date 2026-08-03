"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  MoveRight,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Search,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createPaperFolder,
  deleteLibraryPaper,
  getPaperLibraryPaper,
  listPaperLibraryContents,
  movePaper,
  paperSourcePath,
  renameLibraryPaper,
  retryLibraryPaper,
  updateLibraryPaperQuestion,
  type PaperLibraryDetail,
  type PaperLibraryRecord,
  type PaperLibrarySummary,
} from "@/lib/knowledge-api";
import { useCollapsiblePanel } from "@/hooks/useCollapsiblePanel";
import KbFilePreview from "./KbFilePreview";
import type { FilePreviewSource } from "@/components/chat/preview/previewerFor";
import { PaperReview } from "@/components/space/PaperLibraryPanel";

const PROCESSING_STATUSES = new Set(["pending", "processing"]);
const EXAM_READY_STATUSES = new Set([
  "ready",
  "ready_with_warnings",
  "partial",
]);
const PAPER_STATUS_OPTIONS = [
  "pending",
  "processing",
  "ready",
  "ready_with_warnings",
  "partial",
  "failed",
] as const;

function statusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case "ready":
      return t("File ready");
    case "ready_with_warnings":
      return t("File ready with warnings");
    case "partial":
      return t("File partially ready");
    case "failed":
      return t("File extraction failed");
    case "processing":
      return t("File processing");
    default:
      return t("File pending");
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "ready":
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300";
    case "failed":
      return "bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-300";
    case "partial":
    case "ready_with_warnings":
      return "bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300";
    default:
      return "bg-sky-100 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300";
  }
}

interface PaperTreeNode {
  name: string;
  path: string;
  type: "folder" | "paper";
  paper?: PaperLibraryRecord;
  children: PaperTreeNode[];
}

function parentFolder(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function buildPaperTree(
  folders: string[],
  papers: PaperLibraryRecord[],
): PaperTreeNode[] {
  const folderNodes = new Map<string, PaperTreeNode>();
  const root: PaperTreeNode[] = [];
  const ensureFolder = (path: string): PaperTreeNode => {
    const existing = folderNodes.get(path);
    if (existing) return existing;
    const node: PaperTreeNode = {
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      type: "folder",
      children: [],
    };
    folderNodes.set(path, node);
    const parent = parentFolder(path);
    if (parent) ensureFolder(parent).children.push(node);
    else root.push(node);
    return node;
  };

  folders.forEach((folder) => ensureFolder(folder));
  papers.forEach((paper) => {
    const node: PaperTreeNode = {
      name: paper.display_name,
      path: paper.paper_id,
      type: "paper",
      paper,
      children: [],
    };
    if (paper.folder_path) ensureFolder(paper.folder_path).children.push(node);
    else root.push(node);
  });

  const sort = (nodes: PaperTreeNode[]) => {
    nodes.sort((left, right) => {
      if (left.type !== right.type) return left.type === "folder" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
    nodes.forEach((node) => sort(node.children));
  };
  sort(root);
  return root;
}

interface PaperLibraryPapersTabProps {
  libraryId: string;
  libraries: PaperLibrarySummary[];
}

export default function PaperLibraryPapersTab({
  libraryId,
  libraries,
}: PaperLibraryPapersTabProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const listPanel = useCollapsiblePanel("paper-library-paper-list");
  const [papers, setPapers] = useState<PaperLibraryRecord[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [selectedFolderPath, setSelectedFolderPath] = useState(
    searchParams.get("folder") ?? "",
  );
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selectedPaperId, setSelectedPaperId] = useState<string | null>(
    searchParams.get("paper"),
  );
  const [selectedPaper, setSelectedPaper] =
    useState<PaperLibraryDetail | null>(null);
  const [reviewDismissedId, setReviewDismissedId] = useState<string | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [savingQuestionId, setSavingQuestionId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(
    null,
  );

  const updatePaperQuery = useCallback(
    (paperId: string | null, review = false) => {
      const params = new URLSearchParams(searchParams.toString());
      if (paperId) params.set("paper", paperId);
      else params.delete("paper");
      if (review) params.set("review", "1");
      else params.delete("review");
      const queryString = params.toString();
      router.push(`${pathname}${queryString ? `?${queryString}` : ""}`, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  const updateFolderQuery = useCallback(
    (folderPath: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (folderPath) params.set("folder", folderPath);
      else params.delete("folder");
      const queryString = params.toString();
      router.push(`${pathname}${queryString ? `?${queryString}` : ""}`, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const contents = await listPaperLibraryContents(libraryId, {
        search,
        status,
      });
      setPapers(contents.papers);
      setFolders(contents.folders);
      setExpandedFolders((previous) =>
        previous.size ? previous : new Set(contents.folders),
      );
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [libraryId, search, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!papers.some((paper) => PROCESSING_STATUSES.has(paper.status))) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [load, papers]);

  const selectedSummary = useMemo(
    () => papers.find((paper) => paper.paper_id === selectedPaperId) ?? null,
    [papers, selectedPaperId],
  );

  const loadReview = useCallback(
    async (paperId: string) => {
      setReviewLoading(true);
      setReviewDismissedId(null);
      setErrorMsg(null);
      try {
        setSelectedPaper(await getPaperLibraryPaper(paperId));
        setSelectedPaperId(paperId);
        updatePaperQuery(paperId, true);
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : String(error));
      } finally {
        setReviewLoading(false);
      }
    },
    [updatePaperQuery],
  );

  useEffect(() => {
    if (
      searchParams.get("review") !== "1" ||
      !searchParams.get("paper") ||
      selectedPaper ||
      reviewLoading ||
      reviewDismissedId === searchParams.get("paper")
    ) {
      return;
    }
    void loadReview(searchParams.get("paper") as string);
  }, [loadReview, reviewDismissedId, reviewLoading, searchParams, selectedPaper]);

  const handleStartQuiz = useCallback(
    (paperId: string) => {
      router.push(
        `/home?exam_paper_id=${encodeURIComponent(paperId)}&exam_library_id=${encodeURIComponent(libraryId)}`,
      );
    },
    [libraryId, router],
  );

  const handleSaveQuestion = useCallback(
    async (
      questionId: string,
      questionNumber: string,
      answer: string,
      images: string[],
    ) => {
      if (!selectedPaper) throw new Error(t("No file selected"));
      setSavingQuestionId(questionId);
      try {
        const updated = await updateLibraryPaperQuestion(
          libraryId,
          selectedPaper.paper_id,
          questionId,
          { question_number: questionNumber, answer, images },
        );
        setSelectedPaper((previous) =>
          previous
            ? {
                ...previous,
                questions: previous.questions.map((question) =>
                  question.question_id === updated.question_id
                    ? updated
                    : {
                        ...question,
                        images: question.images.filter(
                          (image) => !updated.images.includes(image),
                        ),
                      },
                ),
              }
            : previous,
        );
        return updated;
      } finally {
        setSavingQuestionId(null);
      }
    },
    [libraryId, selectedPaper, t],
  );

  const handleRetry = useCallback(
    async (paperId: string) => {
      if (!window.confirm(t("Retry extraction for this file?"))) return;
      setErrorMsg(null);
      try {
        await retryLibraryPaper(libraryId, paperId);
        await load();
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : String(error));
      }
    },
    [libraryId, load, t],
  );

  const handleDelete = useCallback(
    async (paperId: string, displayName: string) => {
      if (!window.confirm(t("Delete file {{name}}?", { name: displayName }))) {
        return;
      }
      setErrorMsg(null);
      try {
        await deleteLibraryPaper(libraryId, paperId);
        setPapers((previous) =>
          previous.filter((paper) => paper.paper_id !== paperId),
        );
        if (selectedPaperId === paperId) {
          setSelectedPaperId(null);
          setSelectedPaper(null);
          updatePaperQuery(null);
        }
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : String(error));
      }
    },
    [libraryId, selectedPaperId, t, updatePaperQuery],
  );

  const handleRename = useCallback(async () => {
    if (!editing || !editing.name.trim()) return;
    try {
      const updated = await renameLibraryPaper(
        libraryId,
        editing.id,
        editing.name.trim(),
      );
      setPapers((previous) =>
        previous.map((paper) =>
          paper.paper_id === updated.paper_id ? updated : paper,
        ),
      );
      setSelectedPaper((previous) =>
        previous && previous.paper_id === updated.paper_id
          ? { ...previous, ...updated }
          : previous,
      );
      setEditing(null);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error));
    }
  }, [editing, libraryId]);

  const handleCreateFolder = useCallback(
    async (name: string, parentPath: string) => {
      if (!name.trim()) return;
      setErrorMsg(null);
      try {
        const path = await createPaperFolder(libraryId, name, parentPath);
        setFolders((previous) => [...previous, path]);
        setExpandedFolders((previous) => {
          const next = new Set(previous);
          if (parentPath) next.add(parentPath);
          next.add(path);
          return next;
        });
        setSelectedFolderPath(path);
        updateFolderQuery(path);
        await load();
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : String(error));
      }
    },
    [libraryId, load, updateFolderQuery],
  );

  const handleMove = useCallback(
    async (
      paperId: string,
      targetLibraryId: string,
      targetFolderPath = "",
    ) => {
      setErrorMsg(null);
      try {
        const moved = await movePaper(
          libraryId,
          paperId,
          targetLibraryId,
          targetFolderPath,
        );
        if (targetLibraryId !== libraryId) {
          setPapers((previous) =>
            previous.filter((paper) => paper.paper_id !== paperId),
          );
          if (selectedPaperId === paperId) {
            setSelectedPaperId(null);
            setSelectedPaper(null);
            updatePaperQuery(null);
          }
        } else {
          setPapers((previous) =>
            previous.map((paper) =>
              paper.paper_id === moved.paper_id ? moved : paper,
            ),
          );
          setSelectedFolderPath(targetFolderPath);
          updateFolderQuery(targetFolderPath);
        }
        await load();
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : String(error));
      }
    },
    [libraryId, load, selectedPaperId, updateFolderQuery, updatePaperQuery],
  );

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const clearReview = useCallback(() => {
    setSelectedPaper(null);
    setReviewDismissedId(selectedPaperId);
    updatePaperQuery(selectedPaperId);
  }, [selectedPaperId, updatePaperQuery]);

  if (reviewLoading) {
    return (
      <div className="flex min-h-[300px] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--muted-foreground)]" />
      </div>
    );
  }

  if (selectedPaper) {
    return (
      <div className="h-full overflow-y-auto px-6 py-5">
        <div className="mx-auto w-full max-w-5xl">
          <PaperReview
            paper={selectedPaper}
            onBack={clearReview}
            onStartQuiz={handleStartQuiz}
            onSave={handleSaveQuestion}
            savingQuestionId={savingQuestionId}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background)] sm:flex-row">
      <PaperList
        libraryId={libraryId}
        papers={papers}
        folders={folders}
        libraries={libraries}
        selectedPaperId={selectedPaperId}
        selectedFolderPath={selectedFolderPath}
        expandedFolders={expandedFolders}
        collapsed={listPanel.collapsed}
        loading={loading}
        errorMsg={errorMsg}
        query={query}
        status={status}
        onQueryChange={setQuery}
        onSearch={() => setSearch(query)}
        onStatusChange={setStatus}
        onSelect={(paperId) => {
          setSelectedPaperId(paperId);
          updatePaperQuery(paperId);
        }}
        onDelete={(paperId, name) => void handleDelete(paperId, name)}
        editing={editing}
        onStartRename={(paperId, name) => setEditing({ id: paperId, name })}
        onRename={handleRename}
        onCancelRename={() => setEditing(null)}
        onMove={(paperId, targetLibraryId, targetFolderPath) =>
          void handleMove(paperId, targetLibraryId, targetFolderPath)
        }
        onCreateFolder={(name, parentPath) =>
          void handleCreateFolder(name, parentPath)
        }
        onSelectFolder={(folderPath) => {
          setSelectedFolderPath(folderPath);
          updateFolderQuery(folderPath);
        }}
        onToggleFolder={toggleFolder}
        onToggleCollapsed={listPanel.toggle}
      />
      <div className="min-h-0 min-w-0 flex-1">
        <PaperPreview
          paper={selectedSummary}
          fileListCollapsed={listPanel.collapsed}
          onToggleFileList={listPanel.toggle}
          onReview={(paperId) => void loadReview(paperId)}
          onStartQuiz={handleStartQuiz}
          onRetry={(paperId) => void handleRetry(paperId)}
        />
      </div>
    </div>
  );
}

function PaperList({
  libraryId,
  papers,
  folders,
  libraries,
  selectedPaperId,
  selectedFolderPath,
  expandedFolders,
  collapsed,
  loading,
  errorMsg,
  query,
  status,
  onQueryChange,
  onSearch,
  onStatusChange,
  onSelect,
  onDelete,
  editing,
  onStartRename,
  onRename,
  onCancelRename,
  onMove,
  onCreateFolder,
  onSelectFolder,
  onToggleFolder,
  onToggleCollapsed,
}: {
  libraryId: string;
  papers: PaperLibraryRecord[];
  folders: string[];
  libraries: PaperLibrarySummary[];
  selectedPaperId: string | null;
  selectedFolderPath: string;
  expandedFolders: Set<string>;
  collapsed: boolean;
  loading: boolean;
  errorMsg: string | null;
  query: string;
  status: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onStatusChange: (value: string) => void;
  onSelect: (paperId: string) => void;
  onDelete: (paperId: string, name: string) => void;
  editing: { id: string; name: string } | null;
  onStartRename: (paperId: string, name: string) => void;
  onRename: () => Promise<void>;
  onCancelRename: () => void;
  onMove: (
    paperId: string,
    libraryId: string,
    folderPath?: string,
  ) => void;
  onCreateFolder: (name: string, parentPath: string) => void;
  onSelectFolder: (folderPath: string) => void;
  onToggleFolder: (folderPath: string) => void;
  onToggleCollapsed: () => void;
}) {
  const { t } = useTranslation();
  const tree = useMemo(() => buildPaperTree(folders, papers), [folders, papers]);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [moveMenuFor, setMoveMenuFor] = useState<string | null>(null);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const submitFolder = () => {
    const parent = newFolderParent ?? "";
    if (!newFolderName.trim()) return;
    onCreateFolder(newFolderName, parent);
    setNewFolderName("");
    setNewFolderParent(null);
  };

  const movePaperTo = (
    paperId: string,
    targetLibraryId: string,
    targetFolderPath = "",
  ) => {
    setMoveMenuFor(null);
    setDropTarget(null);
    setDragPath(null);
    onMove(paperId, targetLibraryId, targetFolderPath);
  };

  const renderNode = (node: PaperTreeNode, depth: number): React.ReactNode => {
    const indent = { paddingLeft: `${depth * 12 + 4}px` };
    if (node.type === "folder") {
      const open = expandedFolders.has(node.path);
      return (
        <li key={`folder:${node.path}`}>
          <div
            role="button"
            tabIndex={0}
            style={indent}
            onClick={() => {
              onSelectFolder(node.path);
              onToggleFolder(node.path);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectFolder(node.path);
                onToggleFolder(node.path);
              }
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setDropTarget(node.path);
            }}
            onDragLeave={() =>
              setDropTarget((current) =>
                current === node.path ? null : current,
              )
            }
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const paperId = event.dataTransfer.getData("text/plain");
              if (paperId) movePaperTo(paperId, libraryId, node.path);
            }}
            className={`group/folder flex items-center gap-1 rounded-md py-1.5 pr-1 text-left text-[11px] transition-colors ${
              selectedFolderPath === node.path
                ? "bg-[var(--primary)]/10 text-[var(--foreground)]"
                : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50"
            } ${dropTarget === node.path ? "bg-[var(--primary)]/15 ring-1 ring-[var(--primary)]/40" : ""}`}
          >
            {open ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
            <Folder size={13} className="shrink-0 text-[var(--primary)]" />
            <span className="min-w-0 flex-1 truncate font-medium">
              {node.name}
            </span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setNewFolderParent(node.path);
                setNewFolderName("");
              }}
              title={t("New child folder")}
              aria-label={t("New child folder")}
              className="rounded p-0.5 opacity-0 transition-opacity hover:bg-[var(--muted)] group-hover/folder:opacity-100"
            >
              <FolderPlus size={11} />
            </button>
          </div>
          {newFolderParent === node.path && (
            <form
              className="my-1 flex items-center gap-1"
              style={{ paddingLeft: `${depth * 12 + 20}px` }}
              onSubmit={(event) => {
                event.preventDefault();
                submitFolder();
              }}
            >
              <input
                autoFocus
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder={t("Folder name")}
                aria-label={t("Folder name")}
                className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-1 text-[10px] text-[var(--foreground)] outline-none"
              />
              <button
                type="submit"
                disabled={!newFolderName.trim()}
                className="rounded bg-[var(--primary)] px-1.5 py-1 text-[9px] text-[var(--primary-foreground)] disabled:opacity-40"
              >
                {t("Add")}
              </button>
            </form>
          )}
          {open && node.children.length > 0 && (
            <ul className="space-y-px">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </ul>
          )}
        </li>
      );
    }

    const paper = node.paper!;
    const canMove = !PROCESSING_STATUSES.has(paper.status);
    const isEditing = editing?.id === paper.paper_id;
    return (
      <li key={`paper:${paper.paper_id}`} className="group/row relative">
        {isEditing ? (
          <form
            className="flex items-center gap-1.5 py-1.5 pr-1"
            style={indent}
            onSubmit={(event) => {
              event.preventDefault();
              void onRename();
            }}
          >
            <input
              autoFocus
              value={editing.name}
              onChange={(event) =>
                onStartRename(paper.paper_id, event.target.value)
              }
              className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-1.5 py-1 text-[11px] text-[var(--foreground)] outline-none"
            />
            <button
              type="submit"
              title={t("Save")}
              aria-label={t("Save")}
              className="rounded p-1 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
            >
              <Check size={12} />
            </button>
            <button
              type="button"
              onClick={onCancelRename}
              title={t("Cancel")}
              aria-label={t("Cancel")}
              className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            >
              ×
            </button>
          </form>
        ) : (
          <div
            draggable={canMove}
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", paper.paper_id);
              event.dataTransfer.effectAllowed = "move";
              setDragPath(paper.paper_id);
            }}
            onDragEnd={() => setDragPath(null)}
            style={indent}
            className={`flex items-center gap-1 rounded-md py-1.5 pr-1 text-left text-[10.5px] transition-colors ${
              selectedPaperId === paper.paper_id
                ? "bg-[var(--primary)]/10 text-[var(--foreground)]"
                : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/50"
            } ${dragPath === paper.paper_id ? "opacity-50" : ""}`}
          >
            <button
              type="button"
              onClick={() => onSelect(paper.paper_id)}
              title={paper.folder_path || t("Library root")}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            >
              <FileText size={12} className="shrink-0 text-[var(--primary)]" />
              <span className="min-w-0 flex-1 truncate">{paper.display_name}</span>
              {paper.status !== "ready_with_warnings" && (
                <span className={`shrink-0 rounded-full px-1 py-0.5 text-[8px] ${statusClass(paper.status)}`}>
                  {statusLabel(paper.status, t)}
                </span>
              )}
            </button>
            <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/row:opacity-100">
              <button
                type="button"
                onClick={() => setMoveMenuFor((current) => current === paper.paper_id ? null : paper.paper_id)}
                disabled={!canMove}
                title={t("Move to…")}
                aria-label={t("Move to…")}
                className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-30"
              >
                <MoveRight size={12} />
              </button>
              <button
                type="button"
                onClick={() => onStartRename(paper.paper_id, paper.display_name)}
                title={t("Rename")}
                aria-label={t("Rename")}
                className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
              >
                <Pencil size={11} />
              </button>
              <button
                type="button"
                disabled={!canMove}
                onClick={() => onDelete(paper.paper_id, paper.display_name)}
                title={
                  canMove ? t("Delete file") : t("Cannot delete while processing")
                }
                aria-label={t("Delete file")}
                className="rounded p-1 text-[var(--muted-foreground)] transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-red-950/30"
              >
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        )}
        {moveMenuFor === paper.paper_id && canMove && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setMoveMenuFor(null)}
            />
            <div className="absolute right-1 top-8 z-20 max-h-60 w-52 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--card)] py-1 shadow-lg">
              <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                {t("Move to")}
              </div>
              {paper.folder_path && (
                <button
                  type="button"
                  onClick={() => movePaperTo(paper.paper_id, libraryId, "")}
                  className="block w-full truncate px-2.5 py-1.5 text-left text-[12px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]/60"
                >
                  / {t("Root")}
                </button>
              )}
              {folders
                .filter((folder) => folder !== paper.folder_path)
                .map((folder) => (
                  <button
                    key={`${libraryId}::${folder}`}
                    type="button"
                    onClick={() => movePaperTo(paper.paper_id, libraryId, folder)}
                    className="block w-full truncate px-2.5 py-1.5 text-left text-[12px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]/60"
                  >
                    {folder}
                  </button>
                ))}
              {libraries
                .filter((library) => library.library_id !== libraryId)
                .flatMap((library) => [
                  <button
                    key={`${library.library_id}::`}
                    type="button"
                    onClick={() => movePaperTo(paper.paper_id, library.library_id, "")}
                    className="block w-full truncate px-2.5 py-1.5 text-left text-[12px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]/60"
                  >
                    {library.name} / {t("Library root")}
                  </button>,
                  ...(library.folders ?? []).map((folder) => (
                    <button
                      key={`${library.library_id}::${folder}`}
                      type="button"
                      onClick={() => movePaperTo(paper.paper_id, library.library_id, folder)}
                      className="block w-full truncate px-2.5 py-1.5 text-left text-[12px] text-[var(--foreground)] transition-colors hover:bg-[var(--muted)]/60"
                    >
                      {library.name} / {folder}
                    </button>
                  )),
                ])}
              {folders.length === 0 && libraries.length <= 1 && (
                <div className="px-2.5 py-1.5 text-[11px] text-[var(--muted-foreground)]">
                  {t("No folders yet")}
                </div>
              )}
            </div>
          </>
        )}
      </li>
    );
  };

  if (collapsed) {
    return (
      <aside className="flex h-full w-[44px] shrink-0 flex-col items-center gap-1 border-r border-[var(--border)] bg-[var(--card)]/40 py-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          title={t("Expand")}
          aria-label={t("Expand")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        >
          <PanelLeftOpen size={13} strokeWidth={1.7} />
        </button>
        <div className="my-1 h-px w-6 bg-[var(--border)]/60" />
        <div className="flex w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto pb-2">
          {papers.map((paper) => (
            <button
              key={paper.paper_id}
              type="button"
              onClick={() => onSelect(paper.paper_id)}
              title={paper.display_name}
              aria-label={paper.display_name}
              className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors ${
                selectedPaperId === paper.paper_id
                  ? "bg-[var(--primary)]/12 ring-1 ring-[var(--primary)]/40"
                  : "hover:bg-[var(--muted)]/60"
              }`}
            >
              {selectedPaperId === paper.paper_id && (
                <span className="absolute -left-1 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-[var(--primary)]" />
              )}
              <FileText size={13} className="text-[var(--primary)]" />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className="flex h-full max-h-[360px] w-full shrink-0 flex-col border-b border-[var(--border)] bg-[var(--card)]/40 sm:max-h-none sm:w-[220px] sm:border-b-0 sm:border-r">
      <div className="flex items-center justify-between gap-1 px-2.5 pb-1.5 pt-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="text-[12px] font-medium text-[var(--foreground)]">
            {t("Files")}
          </span>
          <span className="rounded-full bg-[var(--muted)] px-1.5 py-0 text-[10px] text-[var(--muted-foreground)]">
            {papers.length}
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => {
              setNewFolderParent("");
              setNewFolderName("");
            }}
            title={t("New root folder")}
            aria-label={t("New root folder")}
            className="rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <FolderPlus size={13} strokeWidth={1.7} />
          </button>
          <button
            type="button"
            onClick={onToggleCollapsed}
            title={t("Collapse")}
            aria-label={t("Collapse")}
            className="rounded-md p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <PanelLeftClose size={12} strokeWidth={1.7} />
          </button>
        </div>
      </div>
      {newFolderParent === "" && (
        <form
          className="flex items-center gap-1 px-2.5 pb-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            submitFolder();
          }}
        >
          <input
            autoFocus
            value={newFolderName}
            onChange={(event) => setNewFolderName(event.target.value)}
            placeholder={t("Folder name")}
            aria-label={t("Folder name")}
            className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[11px] text-[var(--foreground)] outline-none"
          />
          <button
            type="submit"
            disabled={!newFolderName.trim()}
            className="rounded-md bg-[var(--primary)] px-2 py-1 text-[10px] font-medium text-[var(--primary-foreground)] disabled:opacity-40"
          >
            {t("Add")}
          </button>
        </form>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 pb-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--muted-foreground)]" />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("Search files...")}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] py-1.5 pl-7 pr-2 text-[11px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
          />
        </div>
        <button
          type="submit"
          className="rounded-md border border-[var(--border)] px-2 py-1.5 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
        >
          {t("Search")}
        </button>
      </form>
      <div className="px-2.5 pb-2">
        <select
          value={status}
          onChange={(event) => onStatusChange(event.target.value)}
          aria-label={t("Filter file status")}
          className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[11px] text-[var(--muted-foreground)] outline-none"
        >
          <option value="">{t("All statuses")}</option>
          {PAPER_STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {statusLabel(option, t)}
            </option>
          ))}
        </select>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2.5">
        {errorMsg && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            {errorMsg}
          </div>
        )}
        {!loading && (folders.length > 0 || papers.length > 0) && (
          <ul
            className={`space-y-px rounded-md ${
              dropTarget === "" ? "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/30" : ""
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              setDropTarget("");
            }}
            onDragLeave={() =>
              setDropTarget((current) => (current === "" ? null : current))
            }
            onDrop={(event) => {
              event.preventDefault();
              const paperId = event.dataTransfer.getData("text/plain");
              if (paperId) movePaperTo(paperId, libraryId, "");
            }}
          >
            {tree.map((node) => renderNode(node, 0))}
          </ul>
        )}
        {loading && !papers.length ? (
          <div className="space-y-1">
            {[0, 1, 2].map((item) => (
              <div
                key={item}
                className="h-8 animate-pulse rounded-md bg-[var(--muted)]/40"
              />
            ))}
          </div>
        ) : !papers.length ? (
          <div className="px-2 py-8 text-center text-[11px] text-[var(--muted-foreground)]">
            <FileText className="mx-auto mb-1.5 h-4 w-4 opacity-50" />
            {t("No files yet")}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function PaperPreview({
  paper,
  fileListCollapsed,
  onToggleFileList,
  onReview,
  onStartQuiz,
  onRetry,
}: {
  paper: PaperLibraryRecord | null;
  fileListCollapsed: boolean;
  onToggleFileList: () => void;
  onReview: (paperId: string) => void;
  onStartQuiz: (paperId: string) => void;
  onRetry: (paperId: string) => void;
}) {
  const { t } = useTranslation();
  const source = useMemo<FilePreviewSource | null>(() => {
    if (!paper) return null;
    return {
      filename: paper.display_name || paper.original_filename,
      mimeType: "application/pdf",
      url: paperSourcePath(paper.paper_id),
      id: paper.paper_id,
    };
  }, [paper]);
  const canExam = paper ? EXAM_READY_STATUSES.has(paper.status) : false;
  const canRetry = paper ? !PROCESSING_STATUSES.has(paper.status) : false;

  if (!paper) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-end border-b border-[var(--border)] bg-[var(--card)]/40 px-3 py-1.5">
          <button
            type="button"
            onClick={onToggleFileList}
            title={fileListCollapsed ? t("Show file list") : t("Hide file list")}
            aria-label={fileListCollapsed ? t("Show file list") : t("Hide file list")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          >
            {fileListCollapsed ? (
              <PanelLeftOpen size={13} strokeWidth={1.7} />
            ) : (
              <PanelLeftClose size={13} strokeWidth={1.7} />
            )}
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--muted)] text-[var(--muted-foreground)]">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <div className="text-[13px] font-medium text-[var(--foreground)]">
              {t("Select a file to preview")}
            </div>
            <p className="mt-1 max-w-xs text-[11.5px] leading-relaxed text-[var(--muted-foreground)]">
              {t("Pick a file from the list on the left to view its PDF here.")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-[var(--border)] bg-[var(--card)]/60 px-3 py-2">
        <span
          className={`mr-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClass(paper.status)}`}
        >
          {statusLabel(paper.status, t)}
        </span>
        {canRetry && (
          <button
            type="button"
            onClick={() => onRetry(paper.paper_id)}
            className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--muted)]"
          >
            {t("Retry")}
          </button>
        )}
        <button
          type="button"
          onClick={() => onReview(paper.paper_id)}
          className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[11px] font-medium text-[var(--foreground)] hover:bg-[var(--muted)]"
        >
          {t("Review questions")}
        </button>
        <button
          type="button"
          disabled={!canExam}
          onClick={() => onStartQuiz(paper.paper_id)}
          className="rounded-md bg-[var(--primary)] px-2.5 py-1 text-[11px] font-medium text-[var(--primary-foreground)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("Start Exam")}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <KbFilePreview
          source={source}
          fileListCollapsed={fileListCollapsed}
          onToggleFileList={onToggleFileList}
          metaSuffix={
            <span>
              {paper.question_count} {t("questions")}
            </span>
          }
        />
      </div>
      {paper.error && (
        <p className="border-t border-red-200 bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {paper.error}
        </p>
      )}
    </div>
  );
}
