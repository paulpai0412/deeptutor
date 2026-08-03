'use client'

import { useCallback, useEffect, useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  ExternalLink,
  FileText,
  Loader2,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import PaperLibraryUploadSection from '@/components/knowledge/PaperLibraryUploadSection'
import MarkdownRenderer from '@/components/common/MarkdownRenderer'
import {
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
  type PaperLibraryDetail,
  type PaperLibraryQuestion,
  type PaperLibraryRecord,
  type PaperLibrarySummary,
} from '@/lib/knowledge-api'
import { apiUrl } from '@/lib/api'

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
      return t('File ready')
    case 'ready_with_warnings':
      return t('File ready with warnings')
    case 'partial':
      return t('File partially ready')
    case 'failed':
      return t('File extraction failed')
    case 'processing':
      return t('File processing')
    default:
      return t('File pending')
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

export function PaperReview({
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

  const handleImageAssignment = async (image: string, questionId: string) => {
    const owners = paper.questions.filter(question => {
      const draft = drafts[question.question_id] ?? {
        questionNumber: question.question_number,
        answer: question.answer,
        images: question.images,
      }
      return draft.images.includes(image)
    })

    if (questionId) {
      const question = paper.questions.find(item => item.question_id === questionId)
      if (!question) return
      const draft = drafts[questionId] ?? {
        questionNumber: question.question_number,
        answer: question.answer,
        images: question.images,
      }
      await onSave(questionId, draft.questionNumber, draft.answer, [
        ...draft.images.filter(item => item !== image),
        image,
      ])
    } else {
      for (const question of owners) {
        const draft = drafts[question.question_id]
        await onSave(
          question.question_id,
          draft.questionNumber,
          draft.answer,
          draft.images.filter(item => item !== image)
        )
      }
    }

    setDrafts(previous =>
      Object.fromEntries(
        paper.questions.map(question => {
          const draft = previous[question.question_id] ?? {
            questionNumber: question.question_number,
            answer: question.answer,
            images: question.images,
          }
          return [
            question.question_id,
            {
              ...draft,
              images:
                question.question_id === questionId
                  ? [...draft.images.filter(item => item !== image), image]
                  : draft.images.filter(item => item !== image),
            },
          ]
        })
      )
    )
  }

  const assignedImages = new Set(Object.values(drafts).flatMap(draft => draft.images))
  const unassignedImages = paper.assets.filter(image => !assignedImages.has(image))
  const renderImage = (image: string, questionId = '') => (
    <figure key={image} className="min-w-0 rounded-lg bg-[var(--muted)]/30 p-2">
      <div className="relative h-40 w-full rounded-md border border-[var(--border)] bg-[var(--background)]">
        <Image
          src={apiUrl(paperAssetPath(paper.paper_id, image))}
          alt={`${t('Image')}: ${image}`}
          fill
          unoptimized
          className="object-contain"
        />
      </div>
      <figcaption className="mt-1 truncate text-[10px] text-[var(--muted-foreground)]">
        {image}
      </figcaption>
      <select
        value={questionId}
        disabled={savingQuestionId !== null}
        aria-label={`${t('Image')}: ${image}`}
        onChange={event => {
          setError(null)
          void handleImageAssignment(image, event.target.value).catch(cause => {
            setError(cause instanceof Error ? cause.message : String(cause))
          })
        }}
        className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[11px] text-[var(--foreground)] outline-none disabled:opacity-50"
      >
        <option value="">{t('None')}</option>
        {paper.questions.map(question => (
          <option key={question.question_id} value={question.question_id}>
            {t('Question')}{' '}
            {drafts[question.question_id]?.questionNumber ?? question.question_number}
          </option>
        ))}
      </select>
    </figure>
  )


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

      {unassignedImages.length > 0 && (
        <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <h3 className="text-[12px] font-medium text-[var(--foreground)]">
            {t('Unassigned images')} · {unassignedImages.length}
          </h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {unassignedImages.map(image => renderImage(image))}
          </div>
        </section>
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

                <div className="mt-3 text-[13px] leading-relaxed text-[var(--foreground)]">
                  <MarkdownRenderer
                    content={question.question_text}
                    variant="compact"
                  />
                </div>

                {Object.keys(question.options).length > 0 && (
                  <dl className="mt-3 space-y-1 rounded-lg bg-[var(--muted)]/30 p-3 text-[12px]">
                    {Object.entries(question.options).map(([key, value]) => (
                      <div key={key} className="flex gap-2">
                        <dt className="font-semibold text-[var(--muted-foreground)]">{key}.</dt>
                        <dd className="text-[var(--foreground)]">
                          <MarkdownRenderer content={value} variant="compact" />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}

                {draft.images.length > 0 && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {draft.images.map(image => renderImage(image, question.question_id))}
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
  /** Hide the legacy inline upload card when rendered in the detail shell. */
  hideUpload?: boolean
}

export default function PaperLibraryPanel({
  libraryId,
  libraries = [],
  hideUpload = false,
}: PaperLibraryPanelProps) {
  const { t } = useTranslation()
  const router = useRouter()
  const [papers, setPapers] = useState<PaperLibraryRecord[]>([])
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [selectedPaper, setSelectedPaper] = useState<PaperLibraryDetail | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [savingQuestionId, setSavingQuestionId] = useState<string | null>(null)

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
                  question.question_id === updated.question_id
                    ? updated
                    : {
                        ...question,
                        images: question.images.filter(image => !updated.images.includes(image)),
                      },
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
      {!hideUpload && (
        <PaperLibraryUploadSection
          libraryId={libraryId}
          onUploaded={load}
          compact
        />
      )}

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
                  <button
                    type="button"
                    onClick={() => window.open(
                      apiUrl(paperSourcePath(paper.paper_id)),
                      '_blank',
                      'noopener,noreferrer',
                    )}
                    className="inline-flex items-center gap-1 text-[var(--primary)] hover:underline"
                  >
                    <ExternalLink size={11} />
                    {t('Open PDF')}
                  </button>
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
