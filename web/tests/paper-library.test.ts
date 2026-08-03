import test from 'node:test'
import assert from 'node:assert/strict'

import {
  deletePaper,
  getPaperLibraryPaper,
  listPaperLibrary,
  listPaperLibraryContents,
  movePaper,
  paperAssetPath,
  paperPreviewTextPath,
  retryPaper,
  updatePaperQuestion,
  uploadPaperLibraryToLibrary,
  type PaperLibraryRecord,
} from '../lib/knowledge-api'

const paper: PaperLibraryRecord = {
  paper_id: 'paper-1',
  display_name: 'Practice.pdf',
  original_filename: 'Practice.pdf',
  source_hash: 'abc123',
  status: 'pending',
  question_count: 0,
  warning_count: 0,
  created_at: '2026-01-01T00:00:00+00:00',
  updated_at: '2026-01-01T00:00:00+00:00',
}

test('paper library list client returns server paper summaries', async () => {
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input)
    assert.equal(init?.credentials, 'include')
    return new Response(JSON.stringify({ papers: [paper] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    assert.deepEqual(await listPaperLibrary({ search: 'Practice' }), [paper])
    assert.equal(requestedUrl, '/api/v1/papers?search=Practice')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('library contents preserve flat folders and paper folder paths', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        papers: [{ ...paper, folder_path: 'Mock/2026' }],
        folders: ['Mock', 'Mock/2026'],
      }),
      { status: 200 }
    )

  try {
    assert.deepEqual(await listPaperLibraryContents('library/1'), {
      papers: [{ ...paper, folder_path: 'Mock/2026' }],
      folders: ['Mock', 'Mock/2026'],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('paper upload client forwards relative folder paths', async () => {
  const originalFetch = globalThis.fetch
  let form: FormData | null = null
  globalThis.fetch = async (_input, init) => {
    form = init?.body as FormData
    return new Response(JSON.stringify({ papers: [], rejected: [], batch_id: 'batch' }), {
      status: 200,
    })
  }
  const file = new File(['pdf'], 'exam.pdf', { type: 'application/pdf' })
  Object.defineProperty(file, 'webkitRelativePath', { value: 'Mock/2026/exam.pdf' })

  try {
    await uploadPaperLibraryToLibrary('library/1', [file])
    const capturedForm = form as unknown as FormData
    assert.equal(capturedForm.getAll('rel_paths')[0], 'Mock/2026/exam.pdf')
    assert.equal((capturedForm.getAll('files')[0] as File).name, 'exam.pdf')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('folder-aware move sends destination folder', async () => {
  const originalFetch = globalThis.fetch
  let body = ''
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body)
    return new Response(JSON.stringify(paper), { status: 200 })
  }
  try {
    await movePaper('library/1', 'paper/1', 'library/2', 'Archive/2026')
    assert.deepEqual(JSON.parse(body), {
      target_library_id: 'library/2',
      target_folder_path: 'Archive/2026',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('paper preview paths encode paper and nested image names', () => {
  assert.equal(paperPreviewTextPath('paper/1'), '/api/v1/papers/paper%2F1/preview-text')
  assert.equal(
    paperAssetPath('paper/1', 'figures/figure 1.png'),
    '/api/v1/papers/paper%2F1/assets/figures/figure%201.png'
  )
})

test('paper lifecycle client retries and deletes a paper', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' })
    return new Response(JSON.stringify({ paper_id: 'paper/1', status: 'pending' }), {
      status: 200,
    })
  }

  try {
    await retryPaper('paper/1')
    await deletePaper('paper/1')
    assert.deepEqual(requests, [
      { url: '/api/v1/papers/paper%2F1/retry', method: 'POST' },
      { url: '/api/v1/papers/paper%2F1', method: 'DELETE' },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('paper library detail client loads and updates a question', async () => {
  const originalFetch = globalThis.fetch
  const requests: Array<{ url: string; method: string }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' })
    if (init?.method === 'PATCH') {
      return new Response(
        JSON.stringify({
          question_id: 'q-1',
          question_number: '2',
          question_text: 'Review me',
          options: {},
          question_type: 'written',
          answer: '',
          images: [],
          is_multi_select: false,
          warnings: [],
        }),
        { status: 200 }
      )
    }
    return new Response(JSON.stringify({ ...paper, questions: [] }), { status: 200 })
  }

  try {
    const detail = await getPaperLibraryPaper('paper/1')
    assert.deepEqual(detail.questions, [])
    const updated = await updatePaperQuestion('paper/1', 'q/1', {
      question_number: '2',
      answer: '',
    })
    assert.equal(updated.question_id, 'q-1')
    assert.deepEqual(requests, [
      { url: '/api/v1/papers/paper%2F1', method: 'GET' },
      {
        url: '/api/v1/papers/paper%2F1/questions/q%2F1',
        method: 'PATCH',
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
