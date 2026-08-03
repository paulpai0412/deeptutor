from __future__ import annotations

from deeptutor.services.quiz.grading import deterministic_grade, normalize_fill_answer


def test_choice_grading_accepts_key_or_exact_option_text() -> None:
    options = {"A": "Alpha", "B": "Beta"}
    assert deterministic_grade(
        question_type="choice",
        options=options,
        correct_answer="B",
        user_answer="b",
    ) is True
    assert deterministic_grade(
        question_type="choice",
        options=options,
        correct_answer="Beta",
        user_answer="B",
    ) is True


def test_concept_grading_accepts_source_paper_symbols() -> None:
    assert deterministic_grade(
        question_type="concept",
        options={},
        correct_answer="○",
        user_answer="true",
    ) is True
    assert deterministic_grade(
        question_type="concept",
        options={},
        correct_answer="╳",
        user_answer="false",
    ) is True


def test_fill_grading_only_normalizes_formatting() -> None:
    assert normalize_fill_answer("  Ｔｅｓｔ，  answer。 ") == "test, answer"
    assert deterministic_grade(
        question_type="fill_in_blank",
        options={},
        correct_answer="Ｔｅｓｔ， answer。",
        user_answer=" test,  ANSWER ",
    ) is True
    assert deterministic_grade(
        question_type="fill_in_blank",
        options={},
        correct_answer="alpha beta",
        user_answer="alpha gamma",
    ) is False


def test_subjective_multiselect_and_missing_answers_require_manual_review() -> None:
    assert deterministic_grade(
        question_type="written",
        options={},
        correct_answer="anything",
        user_answer="anything",
    ) is None
    assert deterministic_grade(
        question_type="choice",
        options={"A": "A", "B": "B"},
        correct_answer="A",
        user_answer="A,B",
        is_multi_select=True,
    ) is None
    assert deterministic_grade(
        question_type="choice",
        options={"A": "A"},
        correct_answer="",
        user_answer="A",
    ) is None
    assert deterministic_grade(
        question_type="choice",
        options={"A": "A", "B": "B"},
        correct_answer="A",
        user_answer="A",
        image_dependent=True,
    ) is True
