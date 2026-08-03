'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Upload, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import FileDropZone from './FileDropZone'
import {
  getKnowledgeUploadPolicy,
  listLibraryPapers,
  uploadPaperLibrary,
  uploadPaperLibraryToLibrary,
  type KnowledgeUploadPolicy,
  type PaperLibraryRecord,
} from '@/lib/knowledge-api'
import { DEFAULT_UPLOAD_POLICY, validateFiles } from '@/lib/knowledge-helpers'

const PAPER_UPLOAD_POLICY: KnowledgeUploadPolicy = {
  ...DEFAULT_UPLOAD_POLICY,
  extensions: ['.pdf'],
  accept: '.pdf,application/pdf',
}

function uploadStatusLabel(status: string, t: (key: string) => string): string {
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

interface PaperLibraryUploadSectionProps {
  libraryId?: string
  onUploaded?: () => Promise<void> | void
  compact?: boolean
}

export default function PaperLibraryUploadSection({
  libraryId,
  onUploaded,
  compact = false,
}: PaperLibraryUploadSectionProps) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<File[]>([])
  const [uploadPolicy, setUploadPolicy] = useState<KnowledgeUploadPolicy>(PAPER_UPLOAD_POLICY)
  const [uploading, setUploading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [batchPapers, setBatchPapers] = useState<PaperLibraryRecord[]>([])

  const paperPolicy = useMemo<KnowledgeUploadPolicy>(
    () => ({
      ...uploadPolicy,
      extensions: ['.pdf'],
      accept: '.pdf,application/pdf',
    }),
    [uploadPolicy]
  )
  const selection = useMemo(() => validateFiles(files, paperPolicy, t), [files, paperPolicy, t])

  useEffect(() => {
    void getKnowledgeUploadPolicy()
      .then(policy => setUploadPolicy(policy))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (
      !libraryId ||
      !batchPapers.some(paper => ['pending', 'processing'].includes(paper.status))
    ) {
      return
    }
    const timer = window.setInterval(() => {
      void listLibraryPapers(libraryId)
        .then(papers => {
          const ids = new Set(batchPapers.map(paper => paper.paper_id))
          setBatchPapers(papers.filter(paper => ids.has(paper.paper_id)))
        })
        .catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [batchPapers, libraryId])

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
      setBatchPapers(result.papers)
      const rejected = result.rejected.length + selection.invalidFiles.length
      setNotice(
        rejected > 0
          ? t('{{count}} files uploaded; {{rejected}} rejected', {
              count: result.papers.length,
              rejected,
            })
          : t('{{count}} files uploaded', { count: result.papers.length })
      )
      await onUploaded?.()
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }, [libraryId, onUploaded, selection, t])

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold text-[var(--foreground)]">{t('Add files')}</h2>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--muted-foreground)]">
              {t('Upload independent PDF files for Exams.')}
            </p>
          </div>
          <Upload className="h-4 w-4 text-[var(--muted-foreground)]" />
        </div>
        <FileDropZone
          files={files}
          onChange={setFiles}
          uploadPolicy={paperPolicy}
          disabled={uploading}
          compact={compact}
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
            {uploading ? t('Uploading...') : t('Upload')}
          </button>
        </div>
        {errorMsg && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
            {errorMsg}
          </p>
        )}
        {notice && (
          <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300">
            {notice}
          </p>
        )}
        {batchPapers.length > 0 && (
          <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              {t('Latest upload status')}
            </div>
            <div className="mt-2 space-y-1.5">
              {batchPapers.map(paper => (
                <div
                  key={paper.paper_id}
                  className="flex items-center gap-2 rounded-md border border-[var(--border)] px-2.5 py-2 text-[11px]"
                >
                  <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">
                    {paper.folder_path
                      ? `${paper.folder_path}/${paper.display_name}`
                      : paper.display_name}
                  </span>
                  {paper.status === 'processing' && (
                    <span className="text-[var(--primary)]">
                      {typeof paper.progress?.percent === 'number'
                        ? `${paper.progress.percent}%`
                        : t('Processing')}
                    </span>
                  )}
                  <span className="rounded-full bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                    {uploadStatusLabel(paper.status, t)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
