from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__
from .engine import (
    GOAL_LABELS,
    PRESETS,
    MatrixError,
    analyze,
    hint,
    operation_result,
    read_board,
    read_operation,
    solve,
)

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI(
    title="Gauss Studio",
    version=__version__,
    description="Точная интерактивная среда для преобразований строк, поиска обратной матрицы и решения A·X = B.",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
)


class BoardIn(BaseModel):
    matrix: list[list[str]] = Field(..., min_length=1)
    augmented: int = Field(default=1, ge=0)
    goal: Literal["echelon", "rref", "inverse", "equation"] = "echelon"


class OperationIn(BoardIn):
    op: Literal["subtract", "add", "swap", "scale"]
    source: int = 0
    target: int = 1
    factor: str | None = "1"


def _board(payload: BoardIn):
    try:
        board, augmented = read_board(payload.matrix, payload.augmented)
        if payload.goal == "inverse":
            rows = len(board)
            cols = len(board[0])
            if augmented != rows or cols != 2 * rows:
                raise MatrixError(
                    "В режиме обратной матрицы нужна матрица [A | I]: "
                    "квадратная A и единичная I справа."
                )
        if payload.goal == "equation":
            rows = len(board)
            cols = len(board[0])
            if cols - augmented != rows or augmented < 1:
                raise MatrixError(
                    "Для уравнения A·X = B нужна квадратная A и хотя бы один столбец B."
                )
        return board, augmented
    except MatrixError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}


@app.get("/api/presets")
def presets() -> dict[str, object]:
    return {"presets": PRESETS, "goals": GOAL_LABELS}


@app.post("/api/analyze")
def analyze_board(payload: BoardIn) -> dict[str, object]:
    board, augmented = _board(payload)
    return analyze(board, augmented, payload.goal)


@app.post("/api/operation")
def perform_operation(payload: OperationIn) -> dict[str, object]:
    board, augmented = _board(payload)
    if len(board) < 2:
        raise HTTPException(
            status_code=422,
            detail="Для преобразований строк нужно хотя бы две строки.",
        )
    try:
        op = read_operation(payload.op, payload.source, payload.target, payload.factor, len(board))
    except MatrixError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return operation_result(board, augmented, payload.goal, op)


@app.post("/api/hint")
def get_hint(payload: BoardIn) -> dict[str, object]:
    board, augmented = _board(payload)
    result = hint(board, augmented, payload.goal)
    result["analysis"] = analyze(board, augmented, payload.goal)
    return result


@app.post("/api/solve")
def get_solution(payload: BoardIn) -> dict[str, object]:
    board, augmented = _board(payload)
    return solve(board, augmented, payload.goal)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.svg", include_in_schema=False)
def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon.svg", media_type="image/svg+xml")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
