import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const viewerSource = readFileSync(
  path.join(process.cwd(), 'components/quiz/QuizViewer.tsx'),
  'utf8'
)
const followupSource = readFileSync(
  path.join(process.cwd(), 'context/QuizFollowupContext.tsx'),
  'utf8'
)

test('submitted quiz can launch the full solve capability with question images', () => {
  const solveHandler = viewerSource.slice(
    viewerSource.indexOf('const handleSolve'),
    viewerSource.indexOf('if (!q) return null')
  )
  const submittedActionsStart = viewerSource.indexOf('{!ans.submitted ?')
  const solveButton = viewerSource.indexOf('onClick={handleSolve}')

  assert.ok(solveButton > submittedActionsStart)
  assert.match(solveHandler, /capability: 'deep_solve'/)
  assert.match(solveHandler, /source_image_attachments/)
  assert.match(solveHandler, /source_images/)
  assert.match(followupSource, /capability: input\.capability \?\? ['"]deep_question['"]/)
})
