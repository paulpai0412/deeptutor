import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

test('QuizViewer renders multiple-choice options through MarkdownRenderer', () => {
  const source = readFileSync(path.join(process.cwd(), 'components/quiz/QuizViewer.tsx'), 'utf8')
  const optionsStart = source.indexOf('{Object.entries(q.options!).map(([key, text]) => {')
  assert.notEqual(optionsStart, -1, 'choice option renderer not found')

  const optionsEnd = source.indexOf(') : isConcept ?', optionsStart)
  assert.notEqual(optionsEnd, -1, 'choice option branch end not found')

  const optionsBranch = source.slice(optionsStart, optionsEnd)
  assert.match(
    optionsBranch,
    /<MarkdownRenderer[\s\S]*content=\{text\}[\s\S]*variant="compact"[\s\S]*enableMath/
  )
  assert.doesNotMatch(optionsBranch, /<span className="leading-relaxed">\{text\}<\/span>/)
  assert.match(optionsBranch, /q\.source_option_images\?\.\[key\]/)
  assert.match(optionsBranch, /alt=\{`\$\{t\('Option'\)\} \$\{key\}`\}/)
})

test('Paper Review always renders extracted question math', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'components/space/PaperLibraryPanel.tsx'),
    'utf8'
  )

  assert.match(
    source,
    /<MarkdownRenderer content=\{question\.question_text\} variant="compact" enableMath \/>/
  )
  assert.match(source, /<MarkdownRenderer content=\{value\} variant="compact" enableMath \/>/)
})
