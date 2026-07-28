'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  ExternalLink,
  FileText,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import FileDropZone from '@/components/knowledge/FileDropZone'
import {
  getKnowledgeUploadPolicy,
  deletePaper,
  deleteLibraryPaper,
  getPaperLibraryPaper,
  listPaperLibrary,
  listLibraryPapers,
  movePaper,
  paperAssetPath,
  paperSourcePath,
  renameLibraryPaper,
  renamePaper,
  retryLibraryPaper,
  retryPaper,
  updateLibraryPaperQuestion,
  updatePaperQuestion,
  uploadPaperLibrary,
  uploadPaperLibraryToLibrary,
  type KnowledgeUploadPolicy,
  type PaperLibraryDetail,
  type PaperLibraryQuestion,
  type PaperLibraryRecord,
  type PaperLibrarySummary,
} from '@/lib/knowledge-api'
import { apiUrl } from '@/lib/api'
import { DEFAULT_UPLOAD_POLICY, validateFiles } from '@/lib/knowledge-helpers'

const PAPER_UPLOAD_POLICY: KnowledgeUploadPolicy = {
  ...DEFAULT_UPLOAD_POLICY,
  extensions: ['.pdf'],
  accept: '.pdf,application/pdf',
}

const PROCESSING_STATUSES = new Set(['pending', 'processing'])
const PAPER_STATUS_OPTIONS = [
  'pending',
  'processing',
  'ready',
  'ready_with_warnings',
  'partial',
  'failed',
] as const

function statusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'ready':
      return t('Paper ready')
    case 'ready_with_warnings':
      return t('Paper ready with warnings')
    case 'partial':
      return t('Paper partially ready')
    case 'failed':
      return t('Paper extraction failed')
    case 'processing':
      return t('Paper processing')
    default:
      return t('Paper pending')
  }
}

function statusClass(status: string): string {
  switch (status) {
    case 'ready':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-950/30 dark:text-red-300'
    case 'partial':
    case 'ready_with_warnings':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'
    default:
      return 'bg-sky-100 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300'
  }
}

interface PaperReviewProps {
  paper: PaperLibraryDetail
  onBack: () => void
  onStartQuiz: (paperId: string) => void
  onSave: (
    questionId: string,
    questionNumber: string,
    answer: string,
    images: string[],
  ) => Promise<PaperLibraryQuestion>
  savingQuestionId: string | null
}

function PaperReview({
  paper,
  onBack,
  onStartQuiz,
  onSave,
  savingQuestionId,
}: PaperReviewProps) {
  const { t } = useTranslation()
  const [drafts, setDrafts] = useState<
    Record<string, { questionNumber: string; answer: string; images: string[] }>
  >(() =>
    Object.fromEntries(
      paper.questions.map(question => [question.question_id, {
        questionNumber: question.question_number,
        answer: question.answer,
        images: [...question.images],
      }]),
    ),
  )
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
      >
        <ArrowLeft size={14} />
        {t('Back to Paper Library')}
      </button>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-[var(--foreground)]">
              {paper.display_name}
            </h2>
            <p className="mt-1 truncate text-[11px] text-[var(--muted-foreground)]">
              {paper.original_filename}
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClass(paper.status)}`}
          >
            {statusLabel(paper.status, t)}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-[var(--muted-foreground)]">
          <span>{paper.question_count} {t('questions')}</span>
          {paper.parser_engine && <span>{paper.parser_engine}</span>}
          {paper.task_id && <span>{t('Task')}: {paper.task_id}</span>}
          <button
            type="button"
            disabled={!['ready', 'ready_with_warnings', 'partial'].includes(paper.status)}
            onClick={() => onStartQuiz(paper.paper_id)}
            className="ml-auto rounded-md bg-[var(--primary)] px-2.5 py-1.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('Start Exam')}
          </button>
        </div>
        {paper.error && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:bg-red-950/20 dark:text-red-300">
            {paper.error}
          </p>
        )}
        {paper.warnings && paper.warnings.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 rounded-lg bg-amber-50 px-5 py-2 text-[12px] text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
            {paper.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
          </ul>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
          {error}
        </p>
      )}

      {paper.questions.length === 0 ? (
        <div className="flex min-h-[220px] items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-[12px] text-[var(--muted-foreground)]">
          {t('No extracted questions yet.')}
        </div>
      ) : (
        <ol className="space-y-3">
          {paper.questions.map(question => {
            const draft = drafts[question.question_id] ?? {
              questionNumber: question.question_number,
              answer: question.answer,
              images: question.images,
            }
            const saving = savingQuestionId === question.question_id
            return (
              <li
                key={question.question_id}
                className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <label className="flex items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
                    {t('Question number')}
                    <input
                      value={draft.questionNumber}
                      onChange={event =>
                        setDrafts(previous => ({
                          ...previous,
                          [question.question_id]: {
                            ...draft,
                            questionNumber: event.target.value,
                          },
                        }))
                      }
                      className="w-24 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[12px] text-[var(--foreground)] outline-none"
                    />
                  </label>
                  <span className="rounded-md bg-[var(--muted)] px-2 py-1 text-[10px] text-[var(--muted-foreground)]">
                    {question.question_type}
                    {question.difficulty ? ` · ${question.difficulty}` : ''}
                    {question.page ? ` · ${t('Page')} ${question.page}` : ''}
                  </span>
                </div>

                <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--foreground)]">
                  {question.question_text}
                </p>

                {Object.keys(question.options).length > 0 && (
                  <dl className="mt-3 space-y-1 rounded-lg bg-[var(--muted)]/30 p-3 text-[12px]">
                    {Object.entries(question.options).map(([key, value]) => (
                      <div key={key} className="flex gap-2">
                        <dt className="font-semibold text-[var(--muted-foreground)]">{key}.</dt>
                        <dd className="whitespace-pre-wrap text-[var(--foreground)]">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                {draft.images.length > 0 && (
                  <div className="mt-3 rounded-lg bg-[var(--muted)]/30 p-3">
                    <p className="mb-2 text-[11px] text-[var(--muted-foreground)]">
                      {t('Related images')}
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {draft.images.map(image => (
                        <figure key={image} className="group relative min-w-0">
                          <img
                            src={apiUrl(paperAssetPath(paper.paper_id, image))}
                            alt={`${t('Related image')}: ${image}`}
                            loading="lazy"
                            className="max-h-72 w-full rounded-md border border-[var(--border)] bg-[var(--background)] object-contain"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const images = draft.images.filter(item => item !== image)
                              setDrafts(previous => ({
                                ...previous,
                                [question.question_id]: { ...draft, images },
                              }))
                              setError(null)
                              void onSave(
                                question.question_id,
                                draft.questionNumber,
                                draft.answer,
                                images,
                              ).catch(cause => {
                                setError(cause instanceof Error ? cause.message : String(cause))
                              })
                            }}
                            className="absolute right-1 top-1 inline-flex items-center gap-1 rounded-md bg-black/65 px-1.5 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100"
                            title={t('Remove image association')}
                          >
                            <X size={10} />
                            {t('Remove')}
                          </button>
                          <figcaption className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]">
                            {image}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  </div>
                )}

                {question.warnings.length > 0 && (
                  <ul className="mt-3 list-disc space-y-1 pl-5 text-[11px] text-amber-700 dark:text-amber-300">
                    {question.warnings.map((warning, index) => (
                      <li key={`${warning}-${index}`}>{warning}</li>
                    ))}
                  </ul>
                )}

                <label className="mt-3 block text-[11px] text-[var(--muted-foreground)]">
                  {t('Reference answer')}
                  <textarea
                    value={draft.answer}
                    onChange={event =>
                      setDrafts(previous => ({
                        ...previous,
                        [question.question_id]: {
                          ...draft,
                          answer: event.target.value,
                        },
                      }))
                    }
                    rows={3}
                    className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[12px] text-[var(--foreground)] outline-none"
                  />
                </label>
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    disabled={saving || !draft.questionNumber.trim()}
                    onClick={() => {
                      setError(null)
                      void onSave(
                        question.question_id,
                        draft.questionNumber,
                        draft.answer,
                        draft.images,
                      ).catch(error => {
                        setError(error instanceof Error ? error.message : String(error))
                      })
                    }}
                    className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {saving ? <Loader2 size={12} className="animate-spin" /> : t('Save correction')}
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

interface PaperLibraryPanelProps {
  /** When provided, use the library-scoped API; omitted keeps legacy callers working. */
  libraryId?: string
  /** Other libraries available for a move action in the Knowledge Center. */
  libraries?: PaperLibrarySummary[]
}

export default function PaperLibraryPanel({
  libraryId,
  libraries = [],
}: PaperLibraryPanelProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const [papers, setPapers] = useState<PaperLibraryRecord[]>([])
  const [files, setFiles] = useState<File[]>([])
  const [uploadPolicy, setUploadPolicy] = useState<KnowledgeUploadPolicy>(PAPER_UPLOAD_POLICY)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [selectedPaper, setSelectedPaper] = useState<PaperLibraryDetail | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [savingQuestionId, setSavingQuestionId] = useState<string | null>(null)

  const paperPolicy = useMemo<KnowledgeUploadPolicy>(
    () => ({
      ...uploadPolicy,
      extensions: ['.pdf'],
      accept: '.pdf,application/pdf',
    }),
    [uploadPolicy],
  )
  const selection = useMemo(
    () => validateFiles(files, paperPolicy, t),
    [files, paperPolicy, t],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      setPapers(
        libraryId
          ? await listLibraryPapers(libraryId, { search, status })
          : await listPaperLibrary({ search, status }),
      )
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [libraryId, search, status])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!papers.some(paper => PROCESSING_STATUSES.has(paper.status))) return
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [load, papers])

  useEffect(() => {
    void getKnowledgeUploadPolicy()
      .then(policy => setUploadPolicy(policy))
      .catch(() => undefined)
  }, [])

  const handleUpload = useCallback(async () => {
    if (selection.validFiles.length === 0) return
    setUploading(true)
    setErrorMsg(null)
    setNotice(null)
    try {
      const result = libraryId
        ? await uploadPaperLibraryToLibrary(libraryId, selection.validFiles)
        : await uploadPaperLibrary(selection.validFiles)
      setFiles([])
      const rejected = result.rejected.length + selection.invalidFiles.length
      setNotice(
        rejected > 0
          ? t('{{count}} papers uploaded; {{rejected}} rejected', {
              count: result.papers.length,
              rejected,
            })
          : t('{{count}} papers uploaded', { count: result.papers.length }),
      )
      await load()
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }, [libraryId, load, selection, t])

  const handleStartQuiz = useCallback((paperId: string) => {
    const libraryQuery = libraryId
      ? `&exam_library_id=${encodeURIComponent(libraryId)}`
      : ''
    router.push(`/home?exam_paper_id=${encodeURIComponent(paperId)}${libraryQuery}`)
  }, [libraryId, router])

  const handleOpenPaper = useCallback(async (paperId: string) => {
    setReviewLoading(true)
    setErrorMsg(null)
    try {
      setSelectedPaper(await getPaperLibraryPaper(paperId))
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewLoading(false)
    }
  }, [])

  const handleSaveQuestion = useCallback(
    async (
      questionId: string,
      questionNumber: string,
      answer: string,
      images: string[],
    ) => {
      if (!selectedPaper) throw new Error(t('No paper selected'))
      setSavingQuestionId(questionId)
      try {
        const updated = libraryId
          ? await updateLibraryPaperQuestion(
              libraryId,
              selectedPaper.paper_id,
              questionId,
              { question_number: questionNumber, answer, images },
            )
          : await updatePaperQuestion(
              selectedPaper.paper_id,
              questionId,
              { question_number: questionNumber, answer, images },
            )
        setSelectedPaper(previous =>
          previous
            ? {
                ...previous,
                questions: previous.questions.map(question =>
                  question.question_id === updated.question_id ? updated : question,
                ),
              }
            : previous,
        )
        return updated
      } finally {
        setSavingQuestionId(null)
      }
    },
    [libraryId, selectedPaper, t],
  )

  const handleRetry = useCallback(async (paperId: string) => {
    if (!window.confirm(t('Retry extraction for this paper?'))) return
    setErrorMsg(null)
    try {
      if (libraryId) await retryLibraryPaper(libraryId, paperId)
      else await retryPaper(paperId)
      await load()
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    }
  }, [libraryId, load, t])

  const handleDelete = useCallback(async (paperId: string, displayName: string) => {
    if (!window.confirm(t('Delete paper {{name}}?', { name: displayName }))) return
    setErrorMsg(null)
    try {
      if (libraryId) await deleteLibraryPaper(libraryId, paperId)
      else await deletePaper(paperId)
      setPapers(previous => previous.filter(paper => paper.paper_id !== paperId))
      setSelectedPaper(previous => previous?.paper_id === paperId ? null : previous)
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    }
  }, [libraryId, t])

  const handleRename = useCallback(async () => {
    if (!editing || !editing.name.trim()) return
    try {
      const updated = libraryId
        ? await renameLibraryPaper(libraryId, editing.id, editing.name.trim())
        : await renamePaper(editing.id, editing.name.trim())
      setPapers(previous =>
        previous.map(paper => (paper.paper_id === updated.paper_id ? updated : paper)),
      )
      setSelectedPaper(previous =>
        previous && previous.paper_id === updated.paper_id
          ? { ...previous, ...updated }
          : previous,
      )
      setEditing(null)
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    }
  }, [editing, libraryId])

  const handleMove = useCallback(
    async (paperId: string, targetLibraryId: string) => {
      if (!libraryId || !targetLibraryId || targetLibraryId === libraryId) return
      setErrorMsg(null)
      try {
        await movePaper(libraryId, paperId, targetLibraryId)
        setPapers((previous) => previous.filter((paper) => paper.paper_id !== paperId))
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : String(error))
      }
    },
    [libraryId],
  )

  if (reviewLoading) {
    return (
      <div className="flex min-h-[300px] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--muted-foreground)]" />
      </div>
    )
  }

  if (selectedPaper) {
    return (
      <PaperReview
        paper={selectedPaper}
        onBack={() => setSelectedPaper(null)}
        onStartQuiz={handleStartQuiz}
        onSave={handleSaveQuestion}
        savingQuestionId={savingQuestionId}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--foreground)]">
              {t('Paper Library')}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--muted-foreground)]">
              {t('Upload independent PDF papers for Exams.')}
            </p>
          </div>
          <Upload className="h-4 w-4 text-[var(--muted-foreground)]" />
        </div>
        <FileDropZone
          files={files}
          onChange={setFiles}
          uploadPolicy={paperPolicy}
          disabled={uploading}
          compact
          hidePolicyHint
        />
        <div className="mt-3 flex items-center justify-end gap-2">
          {files.length > 0 && (
            <button
              type="button"
              onClick={() => setFiles([])}
              disabled={uploading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-40"
            >
              <X size={13} />
              {t('Clear selection')}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleUpload()}
            disabled={uploading || selection.validFiles.length === 0}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {uploading ? t('Uploading...') : t('Upload PDFs')}
          </button>
        </div>
        {notice && (
          <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
            {notice}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={event => {
            event.preventDefault()
            setSearch(query)
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted-foreground)]" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('Search papers...')}
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] py-2 pl-8 pr-3 text-[12px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
            />
          </div>
          <button
            type="submit"
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
          >
            {t('Search')}
          </button>
        </form>
        <select
          value={status}
          onChange={event => setStatus(event.target.value)}
          aria-label={t('Filter paper status')}
          className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-2 text-[12px] text-[var(--muted-foreground)] outline-none"
        >
          <option value="">{t('All statuses')}</option>
          {PAPER_STATUS_OPTIONS.map(option => (
            <option key={option} value={option}>{statusLabel(option, t)}</option>
          ))}
        </select>
        <span className="shrink-0 text-[12px] text-[var(--muted-foreground)]">
          {papers.length} {t('papers')}
        </span>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
          {errorMsg}
        </div>
      )}

      {loading ? (
        <div className="flex min-h-[220px] items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--muted-foreground)]" />
        </div>
      ) : papers.length === 0 ? (
        <div className="flex min-h-[220px] flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-center">
          <FileText className="mb-3 h-5 w-5 text-[var(--muted-foreground)]" />
          <p className="text-[13px] font-medium text-[var(--foreground)]">{t('No papers yet')}</p>
          <p className="mt-1 text-[12px] text-[var(--muted-foreground)]">
            {t('Upload a PDF to create a paper resource.')}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {papers.map(paper => (
            <li
              key={paper.paper_id}
              className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {editing?.id === paper.paper_id ? (
                    <form
                      className="flex items-center gap-2"
                      onSubmit={event => {
                        event.preventDefault()
                        void handleRename()
                      }}
                    >
                      <input
                        autoFocus
                        value={editing.name}
                        onChange={event => setEditing({ ...editing, name: event.target.value })}
                        className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[13px] text-[var(--foreground)] outline-none"
                      />
                      <button
                        type="submit"
                        className="rounded-md bg-[var(--primary)] px-2 py-1 text-[11px] font-medium text-white"
                      >
                        {t('Save')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded-md border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--muted-foreground)]"
                      >
                        {t('Cancel')}
                      </button>
                    </form>
                  ) : (
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 shrink-0 text-[var(--primary)]" />
                      <span className="truncate text-[13px] font-medium text-[var(--foreground)]">
                        {paper.display_name}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditing({ id: paper.paper_id, name: paper.display_name })}
                        title={t('Rename')}
                        className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                  )}
                  <div className="mt-1 truncate text-[11px] text-[var(--muted-foreground)]">
                    {paper.original_filename}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClass(paper.status)}`}
                >
                  {statusLabel(paper.status, t)}
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-[var(--muted-foreground)]">
                <span>
                  {paper.question_count} {t('questions')}
                  {paper.status === 'processing' && typeof paper.progress?.percent === 'number'
                    ? ` · ${paper.progress.percent}%`
                    : ''}
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => void handleOpenPaper(paper.paper_id)}
                    className="text-[var(--primary)] hover:underline"
                  >
                    {t('Review')}
                  </button>
                  <button
                    type="button"
                    disabled={!['ready', 'ready_with_warnings', 'partial'].includes(paper.status)}
                    onClick={() => handleStartQuiz(paper.paper_id)}
                    className="text-[var(--primary)] hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('Exam')}
                  </button>
                  {!PROCESSING_STATUSES.has(paper.status) && paper.status !== 'pending' && (
                    <button
                      type="button"
                      onClick={() => void handleRetry(paper.paper_id)}
                      className="text-[var(--primary)] hover:underline"
                    >
                      {t('Retry')}
                    </button>
                  )}
                  <a
                    href={apiUrl(paperSourcePath(paper.paper_id))}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[var(--primary)] hover:underline"
                  >
                    <ExternalLink size={11} />
                    {t('Open PDF')}
                  </a>
                  {libraryId && libraries.length > 1 && paper.status !== 'processing' && (
                    <select
                      value=""
                      aria-label={t('Move paper')}
                      onChange={event => {
                        const target = event.target.value
                        if (target) void handleMove(paper.paper_id, target)
                      }}
                      className="max-w-[110px] rounded border border-[var(--border)] bg-[var(--card)] px-1 py-1 text-[10px] text-[var(--muted-foreground)]"
                    >
                      <option value="">{t('Move')}</option>
                      {libraries
                        .filter(library => library.library_id !== libraryId)
                        .map(library => (
                          <option key={library.library_id} value={library.library_id}>
                            {library.name}
                          </option>
                        ))}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={paper.status === 'processing'}
                    onClick={() => void handleDelete(paper.paper_id, paper.display_name)}
                    title={paper.status === 'processing' ? t('Cannot delete while processing') : t('Delete paper')}
                    className="rounded p-1 text-[var(--muted-foreground)] hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-red-950/30"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
