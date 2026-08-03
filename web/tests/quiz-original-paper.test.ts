import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildQuizFollowupConfig,
  buildQuizWSConfig,
  extractQuizQuestions,
  extractQuizQuestionsFromEvents,
  extractStreamingQuizQuestions,
  findReferencedQuizQuestion,
  getQuizQuestionOptions,
  normalizeQuizConfig,
  summarizeQuizConfig,
  type DeepQuestionFormConfig,
  type QuizQuestion,
} from '../lib/quiz-types'

const originalConfig: DeepQuestionFormConfig = {
  mode: 'original_paper',
  topic: 'ignored',
  num_questions: 20,
  difficulty: 'hard',
  question_types: ['choice'],
  per_type_counts: { choice: 20 },
  paper_path: '/must-not-be-sent',
  paper_id: 'paper-123',
  max_questions: 100,
}

test('Original Paper request sends only its opaque paper ID', () => {
  assert.deepEqual(buildQuizWSConfig(originalConfig), {
    mode: 'original_paper',
    paper_id: 'paper-123',
  })
})

test('normalizes persisted quiz config from before paper_id existed', () => {
  const restored = normalizeQuizConfig({
    mode: 'custom',
    topic: 'old quiz',
    num_questions: 3,
    difficulty: 'auto',
    question_types: [],
    per_type_counts: {},
    paper_path: '',
    max_questions: 10,
  })

  assert.equal(restored.paper_id, '')
  assert.doesNotThrow(() => summarizeQuizConfig({ ...restored, mode: 'original_paper' }))
})

test('Original Paper summary names the selected paper ID', () => {
  assert.equal(summarizeQuizConfig(originalConfig), 'Original Paper · paper-123')
})

test('quiz follow-up preserves choice options for display and LLM context', () => {
  const question: QuizQuestion = {
    question_id: 'q-1',
    question: 'Which answer is correct?',
    question_type: 'choice',
    options: { A: 'First answer', B: 'Second answer' },
    correct_answer: 'B',
    explanation: '',
  }

  assert.deepEqual(getQuizQuestionOptions(question), [
    ['A', 'First answer'],
    ['B', 'Second answer'],
  ])
  const config = buildQuizFollowupConfig(question, 'A', false, 'quiz-1')
  assert.deepEqual(
    (config.followup_question_context as { options: Record<string, string> }).options,
    question.options
  )
})

test('Original Paper streaming questions retain source metadata and order', () => {
  const questions = extractStreamingQuizQuestions([
    {
      type: 'content',
      metadata: {
        call_kind: 'quiz_question_emitted',
        question_index: 1,
        qa_pair: {
          question_id: 'q-2',
          question: 'Second',
          question_type: 'written',
          correct_answer: 'B',
          explanation: '',
          source_type: 'original_paper',
          paper_id: 'paper-123',
          source_question_number: '2',
        },
      },
    },
    {
      type: 'content',
      metadata: {
        call_kind: 'quiz_question_emitted',
        question_index: 0,
        qa_pair: {
          question_id: 'q-1',
          question: 'First',
          question_type: 'choice',
          correct_answer: 'A',
          explanation: '',
          source_type: 'original_paper',
          paper_id: 'paper-123',
          source_question_number: '1',
          source_images: ['/attachments/a.png'],
          source_option_images: { A: ['/attachments/a.png'] },
        },
      },
    },
  ])

  assert.deepEqual(questions?.[0].source_option_images, {
    A: ['/attachments/a.png'],
  })
  assert.deepEqual(
    questions?.map(question => [
      question.question_id,
      question.source_type,
      question.paper_id,
      question.source_question_number,
    ]),
    [
      ['q-1', 'original_paper', 'paper-123', '1'],
      ['q-2', 'original_paper', 'paper-123', '2'],
    ]
  )
})

test('voice exam reference resolves a persisted question without exposing it to GPT-Live', () => {
  const events = [
    {
      type: 'result',
      metadata: {
        summary: {
          results: [
            {
              qa_pair: {
                question_id: 'q-1',
                question: 'First question',
                question_type: 'choice',
                options: { A: 'Wrong', B: 'Right' },
                paper_id: 'paper-123',
                correct_answer: 'B',
                explanation: 'Because B is right.',
              },
            },
            {
              qa_pair: {
                question_id: 'q-2',
                question: 'Second question',
                question_type: 'written',
                correct_answer: '42',
                explanation: 'Computed result.',
              },
            },
          ],
        },
      },
    },
  ]

  const questions = extractQuizQuestionsFromEvents(events)
  const referenced = findReferencedQuizQuestion('第一題答案是什麼？', questions ?? [])
  assert.equal(referenced?.question_id, 'q-1')
  assert.deepEqual(buildQuizFollowupConfig(referenced!, '', null, 'exam-session'), {
    paper_id: 'paper-123',
    followup_question_context: {
      question_id: 'q-1',
      question: 'First question',
      question_type: 'choice',
      options: { A: 'Wrong', B: 'Right' },
      correct_answer: 'B',
      explanation: 'Because B is right.',
      difficulty: undefined,
      concentration: undefined,
      knowledge_context: undefined,
      user_answer: undefined,
      is_correct: undefined,
      parent_quiz_session_id: 'exam-session',
      user_answer_image_filenames: undefined,
      ai_judgment: undefined,
    },
  })
})

test('voice question reference supports Arabic and English ordinals', () => {
  const questions: QuizQuestion[] = [
    {
      question_id: 'q-1',
      question: 'First',
      question_type: 'written',
      correct_answer: 'A',
      explanation: '',
    },
    {
      question_id: 'q-2',
      question: 'Second',
      question_type: 'written',
      correct_answer: 'B',
      explanation: '',
    },
  ]

  assert.equal(findReferencedQuizQuestion('第 2 題', questions)?.question_id, 'q-2')
  assert.equal(findReferencedQuizQuestion('first question', questions)?.question_id, 'q-1')
  assert.equal(findReferencedQuizQuestion('question #2', questions)?.question_id, 'q-2')
  const elevenQuestions = Array.from({ length: 11 }, (_, index) => ({
    ...questions[0],
    question_id: `q-${index + 1}`,
  }))
  assert.equal(findReferencedQuizQuestion('第十一題', elevenQuestions)?.question_id, 'q-11')
  assert.equal(findReferencedQuizQuestion('Explain the exam', questions), null)
})

test('Original Paper result extraction keeps persisted result order', () => {
  const questions = extractQuizQuestions({
    mode: 'original_paper',
    paper_id: 'paper-123',
    summary: {
      results: [
        {
          qa_pair: {
            question_id: 'q-2',
            question: 'Second',
            question_type: 'written',
            correct_answer: '',
            explanation: '',
            source_type: 'original_paper',
            paper_id: 'paper-123',
            source_question_number: '2',
          },
        },
        {
          qa_pair: {
            question_id: 'q-1',
            question: 'First',
            question_type: 'written',
            correct_answer: '',
            explanation: '',
            source_type: 'original_paper',
            paper_id: 'paper-123',
            source_question_number: '1',
          },
        },
      ],
    },
  })

  assert.deepEqual(
    questions?.map(question => question.question_id),
    ['q-2', 'q-1']
  )
})
