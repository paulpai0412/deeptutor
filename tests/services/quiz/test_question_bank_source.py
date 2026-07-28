from __future__ import annotations

import asyncio

from deeptutor.services.session.sqlite_store import SQLiteSessionStore


def test_question_bank_keeps_original_paper_source_without_foreign_key(tmp_path) -> None:
    store = SQLiteSessionStore(db_path=tmp_path / "history.db")
    session = asyncio.run(store.create_session(session_id="history-session"))
    asyncio.run(
        store.upsert_notebook_entries(
            session["id"],
            [
                {
                    "turn_id": "turn-1",
                    "question_id": "paper-q-1",
                    "question": "Persisted source question",
                    "question_type": "written",
                    "source_type": "original_paper",
                    "paper_library_id": "deleted-library-id",
                    "paper_library_name": "History library",
                    "paper_id": "deleted-paper-id",
                    "paper_display_name": "History paper snapshot",
                    "source_question_number": "7",
                    "source_snapshot_id": "snapshot-1",
                    "grading_method": "manual",
                    "is_correct": None,
                }
            ],
        )
    )

    entry = asyncio.run(store.find_notebook_entry("history-session", "paper-q-1", "turn-1"))
    assert entry is not None
    assert entry["source_type"] == "original_paper"
    assert entry["paper_library_id"] == "deleted-library-id"
    assert entry["paper_library_name"] == "History library"
    assert entry["paper_id"] == "deleted-paper-id"
    assert entry["paper_display_name"] == "History paper snapshot"
    assert entry["source_question_number"] == "7"
    assert entry["source_snapshot_id"] == "snapshot-1"
    assert entry["grading_method"] == "manual"
    assert entry["is_correct"] is None
