"""Exact row-reduction engine for Gauss Studio.

Everything in this module works with :class:`fractions.Fraction`, so every
elementary row operation is exact: no floating point dust, no mysterious
``0.30000000000000004``.  The web layer is deliberately thin; the interesting
linear algebra lives here.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Any, Literal

MAX_ROWS = 8
MAX_COLS = 16
MAX_INPUT_LENGTH = 32
MAX_ABS_TERM = 10**12

OperationKind = Literal["subtract", "add", "swap", "scale"]
GoalKind = Literal["echelon", "rref", "inverse", "equation"]

VARIABLE_NAMES = ("x", "y", "z", "w", "v", "u", "t", "s", "q", "p")

GOAL_LABELS: dict[str, str] = {
    "echelon": "Ступенчатый вид",
    "rref": "Приведённый ступенчатый вид",
    "inverse": "Обратная матрица",
    "equation": "Матричное уравнение",
}


class MatrixError(ValueError):
    """A user-facing validation error."""


def parse_fraction(raw: str | int | Fraction) -> Fraction:
    """Parse a forgiving user value into an exact fraction.

    Accepted forms: ``2``, ``-3``, ``1/2``, ``-3/4``, ``0.25``, ``1,5`` and
    mixed numbers such as ``-1 1/2``.
    """

    if isinstance(raw, Fraction):
        value = raw
    elif isinstance(raw, int):
        value = Fraction(raw)
    else:
        text = str(raw).strip()
        text = (
            text.replace("−", "-")
            .replace("–", "-")
            .replace("—", "-")
            .replace(",", ".")
            .replace("\u00a0", " ")
        )
        if not text:
            return Fraction(0)
        if len(text) > MAX_INPUT_LENGTH:
            raise MatrixError("Слишком длинное число.")
        try:
            if " " in text:
                whole, _, rest = text.partition(" ")
                rest = rest.strip()
                if not rest:
                    value = Fraction(whole)
                else:
                    sign = -1 if whole.strip().startswith("-") else 1
                    whole_abs = whole.strip().lstrip("+-")
                    value = sign * (Fraction(whole_abs) + parse_fraction(rest))
            else:
                value = Fraction(text)
        except (ValueError, ZeroDivisionError) as exc:
            raise MatrixError(f"Не удалось разобрать число «{raw}».") from exc

    if abs(value.numerator) > MAX_ABS_TERM or value.denominator > MAX_ABS_TERM:
        raise MatrixError("Число слишком большое для этой доски.")
    return value


def format_fraction(value: Fraction) -> str:
    """Canonical, compact representation used by the API."""

    if value.denominator == 1:
        return str(value.numerator)
    return f"{value.numerator}/{value.denominator}"


def _human_fraction(value: Fraction) -> str:
    """A typographic fraction for human-facing explanations."""

    return format_fraction(value).replace("-", "−")


def read_board(
    matrix: Sequence[Sequence[str | int]], augmented: int
) -> tuple[list[list[Fraction]], int]:
    """Validate and convert a serialized board into exact values."""

    if not matrix:
        raise MatrixError("Матрица не может быть пустой.")
    rows = len(matrix)
    if rows > MAX_ROWS:
        raise MatrixError(f"Максимум {MAX_ROWS} строк.")
    cols = len(matrix[0])
    if cols == 0:
        raise MatrixError("В матрице должен быть хотя бы один столбец.")
    if cols > MAX_COLS:
        raise MatrixError(f"Максимум {MAX_COLS} столбцов.")
    if any(len(row) != cols for row in matrix):
        raise MatrixError("Все строки должны быть одинаковой длины.")
    if not 0 <= augmented < cols:
        raise MatrixError("Правая часть должна быть внутри матрицы.")
    board = [[parse_fraction(cell) for cell in row] for row in matrix]
    return board, augmented


def serialize_board(board: Sequence[Sequence[Fraction]]) -> list[list[str]]:
    return [[format_fraction(cell) for cell in row] for row in board]


@dataclass(frozen=True)
class RowOp:
    kind: OperationKind
    source: int
    target: int
    factor: Fraction = Fraction(1)


def read_operation(
    kind: str, source: int, target: int, factor: str | int | None, rows: int
) -> RowOp:
    if kind not in {"subtract", "add", "swap", "scale"}:
        raise MatrixError("Неизвестная операция.")
    if not (0 <= source < rows and 0 <= target < rows):
        raise MatrixError("Строка вне матрицы.")
    value = parse_fraction(factor if factor is not None else "1")
    if kind in {"subtract", "add"}:
        if source == target:
            raise MatrixError("Источник и цель должны быть разными строками.")
        if value == 0:
            raise MatrixError("Множитель не может быть нулём.")
    elif kind == "swap":
        if source == target:
            raise MatrixError("Выберите две разные строки.")
        value = Fraction(1)
    elif kind == "scale":
        if value == 0:
            raise MatrixError("Нельзя умножить строку на ноль — это необратимо.")
        target = target if target >= 0 else source
    return RowOp(kind=kind, source=source, target=target, factor=value)


def apply_row_op(
    board: Sequence[Sequence[Fraction]], op: RowOp
) -> tuple[list[list[Fraction]], list[dict[str, Any]]]:
    """Return a new board and a list of changed cells."""

    result = [list(row) for row in board]
    before = [list(row) for row in board]
    rows = len(result)
    if not (0 <= op.source < rows and 0 <= op.target < rows):
        raise MatrixError("Строка вне матрицы.")

    if op.kind == "swap":
        result[op.source], result[op.target] = result[op.target], result[op.source]
    elif op.kind == "scale":
        result[op.target] = [cell * op.factor for cell in result[op.target]]
    elif op.kind in {"subtract", "add"}:
        sign = -1 if op.kind == "subtract" else 1
        result[op.target] = [
            target_cell + sign * op.factor * source_cell
            for target_cell, source_cell in zip(result[op.target], result[op.source], strict=False)
        ]
    else:  # pragma: no cover - guarded by read_operation
        raise MatrixError("Неизвестная операция.")

    changed: list[dict[str, Any]] = []
    compared_rows = (op.source, op.target) if op.kind == "swap" else (op.target,)
    for row in compared_rows:
        for col in range(len(result[0])):
            old = before[row][col]
            new = result[row][col]
            if old != new:
                changed.append(
                    {
                        "row": row,
                        "col": col,
                        "old": format_fraction(old),
                        "new": format_fraction(new),
                        "zeroed": new == 0 and old != 0,
                        "created_from_zero": old == 0 and new != 0,
                    }
                )
    return result, changed


def operation_payload(op: RowOp) -> dict[str, Any]:
    return {
        "kind": op.kind,
        "source": op.source,
        "target": op.target,
        "factor": format_fraction(op.factor),
    }


def operation_expression(op: RowOp) -> str:
    """Pretty, UI-ready expression such as ``R2 − 3·R1 → R2``."""

    source = f"R{op.source + 1}"
    target = f"R{op.target + 1}"
    factor = format_fraction(op.factor)
    factor_part = "" if factor == "1" else f"{factor}·"
    if op.kind == "swap":
        return f"{source} ↔ {target}"
    if op.kind == "scale":
        return f"{target} × {factor} → {target}"
    sign = "−" if op.kind == "subtract" else "+"
    return f"{target} {sign} {factor_part}{source} → {target}"


def _rank_and_pivots(
    board: Sequence[Sequence[Fraction]], limit_cols: int
) -> tuple[list[list[Fraction]], list[tuple[int, int]]]:
    """Gauss-Jordan on a copy, restricted to the first ``limit_cols`` columns."""

    work = [list(row) for row in board]
    rows = len(work)
    pivots: list[tuple[int, int]] = []
    pivot_row = 0
    for col in range(limit_cols):
        if pivot_row >= rows:
            break
        candidate = next((r for r in range(pivot_row, rows) if work[r][col] != 0), None)
        if candidate is None:
            continue
        work[pivot_row], work[candidate] = work[candidate], work[pivot_row]
        pivot = work[pivot_row][col]
        work[pivot_row] = [value / pivot for value in work[pivot_row]]
        for r in range(rows):
            if r != pivot_row and work[r][col] != 0:
                multiplier = work[r][col]
                work[r] = [
                    work[r][c] - multiplier * work[pivot_row][c] for c in range(len(work[r]))
                ]
        pivots.append((pivot_row, col))
        pivot_row += 1
    return work, pivots


def matrix_rank(board: Sequence[Sequence[Fraction]], limit_cols: int) -> int:
    _, pivots = _rank_and_pivots(board, limit_cols)
    return len(pivots)


def _determinant(board: Sequence[Sequence[Fraction]], size: int) -> Fraction:
    """Exact determinant by Gaussian elimination with row swaps."""

    work = [list(row[:size]) for row in board[:size]]
    determinant = Fraction(1)
    for column in range(size):
        pivot = next((row for row in range(column, size) if work[row][column] != 0), None)
        if pivot is None:
            return Fraction(0)
        if pivot != column:
            work[column], work[pivot] = work[pivot], work[column]
            determinant = -determinant
        pivot_value = work[column][column]
        determinant *= pivot_value
        for row in range(column + 1, size):
            if work[row][column] == 0:
                continue
            factor = work[row][column] / pivot_value
            work[row] = [work[row][index] - factor * work[column][index] for index in range(size)]
    return determinant


def _inverse_parts(
    board: Sequence[Sequence[Fraction]], augmented: int
) -> tuple[list[list[Fraction]], list[list[Fraction]]]:
    """Split ``[A | I]`` into A and the right-hand block."""

    rows = len(board)
    cols = len(board[0])
    if augmented != rows or cols != 2 * rows:
        raise MatrixError(
            "Для режима обратной матрицы нужна матрица [A | I]: квадратная A и единичная I справа."
        )
    size = rows
    left = [list(row[:size]) for row in board]
    right = [[row[size + column] for column in range(size)] for row in board]
    return left, right


def _is_identity(matrix: Sequence[Sequence[Fraction]]) -> bool:
    size = len(matrix)
    return all(
        matrix[row][column] == (1 if row == column else 0)
        for row in range(size)
        for column in range(size)
    )


def _inverse_analysis(
    board: Sequence[Sequence[Fraction]], augmented: int, goal: GoalKind
) -> dict[str, Any]:
    left, right = _inverse_parts(board, augmented)
    size = len(left)
    determinant = _determinant(left, size)
    identity = _is_identity(left)
    invertible = determinant != 0
    plan = _plan(board, augmented, "rref") if invertible and not identity else []
    _, coeff_pivots = _rank_and_pivots(board, size)
    pivot_columns = [column for _, column in coeff_pivots]
    zero_rows = sum(1 for row in board if all(cell == 0 for cell in row))
    # In the finished board det(I) = 1, so recover det(A) from A⁻¹ on the right.
    reported_determinant = determinant
    if identity:
        inverse_determinant = _determinant(right, size)
        if inverse_determinant != 0:
            reported_determinant = Fraction(1, 1) / inverse_determinant
    return {
        "rows": size,
        "cols": 2 * size,
        "coefficient_cols": size,
        "augmented": augmented,
        "mode": "inverse",
        "goal": goal,
        "goal_label": GOAL_LABELS[goal],
        "goal_met": identity,
        "remaining_steps": len(plan),
        "rank": matrix_rank(board, size),
        "augmented_rank": matrix_rank(board, size),
        "consistent": invertible,
        "free_variables": 0,
        "zero_rows": zero_rows,
        "pivot_columns": pivot_columns,
        "variable_names": [f"a{index + 1}" for index in range(size)],
        "status": "Обратима" if invertible else "Вырожденная",
        "status_detail": (
            f"det A = {_human_fraction(reported_determinant)}"
            if invertible
            else "det A = 0 · обратной матрицы нет"
        ),
        "solution": None,
        "invertible": invertible,
        "determinant": format_fraction(reported_determinant),
        "inverse": serialize_board(right) if identity else None,
    }


def _equation_parts(
    board: Sequence[Sequence[Fraction]], augmented: int
) -> tuple[list[list[Fraction]], list[list[Fraction]]]:
    """Split ``[A | B]`` into square A and the right-hand matrix B."""

    rows = len(board)
    cols = len(board[0])
    coefficient_cols = cols - augmented
    if coefficient_cols != rows:
        raise MatrixError(
            "Для уравнения A·X = B нужна квадратная A: "
            "число строк и коэффициентных столбцов должно совпадать."
        )
    if augmented < 1:
        raise MatrixError("Для уравнения A·X = B нужен хотя бы один столбец B.")
    left = [list(row[:coefficient_cols]) for row in board]
    right = [[row[coefficient_cols + column] for column in range(augmented)] for row in board]
    return left, right


def _equation_analysis(
    board: Sequence[Sequence[Fraction]], augmented: int, goal: GoalKind
) -> dict[str, Any]:
    left, right = _equation_parts(board, augmented)
    size = len(left)
    determinant = _determinant(left, size)
    identity = _is_identity(left)
    invertible = determinant != 0
    rank_left = matrix_rank(board, size)
    rank_augmented = matrix_rank(board, size + augmented)
    consistent = rank_augmented == rank_left
    free_variables = max(size - rank_left, 0) if consistent else 0
    plan = _plan(board, augmented, "rref") if invertible and not identity else []

    if invertible:
        status = "Обратима"
        status_detail = f"det A = {_human_fraction(determinant)}"
    elif consistent:
        status = "Совместна"
        status_detail = "бесконечно много решений"
    else:
        status = "Несовместна"
        status_detail = "решений нет"

    _, coeff_pivots = _rank_and_pivots(board, size)
    pivot_columns = [column for _, column in coeff_pivots]
    zero_rows = sum(1 for row in board if all(cell == 0 for cell in row))

    return {
        "rows": size,
        "cols": size + augmented,
        "coefficient_cols": size,
        "augmented": augmented,
        "right_columns": augmented,
        "mode": "equation",
        "goal": goal,
        "goal_label": GOAL_LABELS[goal],
        "goal_met": identity,
        "remaining_steps": len(plan),
        "rank": rank_left,
        "augmented_rank": rank_augmented,
        "consistent": consistent,
        "free_variables": free_variables,
        "zero_rows": zero_rows,
        "pivot_columns": pivot_columns,
        "variable_names": [f"a{index + 1}" for index in range(size)],
        "status": status,
        "status_detail": status_detail,
        "solution": None,
        "invertible": invertible,
        "determinant": format_fraction(determinant),
        "inverse": None,
        "solution_matrix": serialize_board(right) if identity else None,
    }


def _is_coefficient_zero_row(row: Sequence[Fraction], coeff_cols: int) -> bool:
    return all(row[col] == 0 for col in range(coeff_cols))


@dataclass(frozen=True)
class PlannedStep:
    op: RowOp
    col: int
    reason: str
    title: str
    why: str


def _plan(board: Sequence[Sequence[Fraction]], augmented: int, goal: GoalKind) -> list[PlannedStep]:
    """Build a short, valid sequence of row operations to the chosen goal."""

    if goal not in {"echelon", "rref"}:
        raise MatrixError("Неизвестная цель.")
    work = [list(row) for row in board]
    rows = len(work)
    cols = len(work[0])
    coeff_cols = cols - augmented
    steps: list[PlannedStep] = []

    def add(step: PlannedStep, result: list[list[Fraction]]) -> None:
        nonlocal work
        steps.append(step)
        work = result

    def perform(op: RowOp, col: int, reason: str, title: str, why: str) -> None:
        result, _ = apply_row_op(work, op)
        add(PlannedStep(op=op, col=col, reason=reason, title=title, why=why), result)

    # Zero coefficient rows belong at the bottom in both goal shapes.
    for row in range(rows):
        if _is_coefficient_zero_row(work[row], coeff_cols):
            below = next(
                (
                    r
                    for r in range(rows - 1, row, -1)
                    if not _is_coefficient_zero_row(work[r], coeff_cols)
                ),
                None,
            )
            if below is not None:
                op = RowOp("swap", row, below)
                perform(
                    op,
                    -1,
                    "zero-row",
                    "Убираем нулевую строку",
                    f"Поменяем R{row + 1} и R{below + 1}: строка без коэффициентов "
                    "должна стоять внизу.",
                )

    pivot_row = 0
    for col in range(coeff_cols):
        if pivot_row >= rows:
            break
        candidates = [r for r in range(pivot_row, rows) if work[r][col] != 0]
        if not candidates:
            continue
        # Prefer a pivot that is already 1 (or −1, which only needs a sign flip).
        candidate = next((r for r in candidates if abs(work[r][col]) == 1), candidates[0])
        if candidate != pivot_row:
            op = RowOp("swap", candidate, pivot_row)
            perform(
                op,
                col,
                "pivot",
                "Поднимаем ведущий элемент",
                f"В R{pivot_row + 1} на ведущей позиции стоит 0. "
                f"Поменяем её с R{candidate + 1}, где элемент ненулевой.",
            )
        pivot = work[pivot_row][col]
        if pivot != 1:
            factor = Fraction(1, 1) / pivot
            op = RowOp("scale", pivot_row, pivot_row, factor)
            divisor = Fraction(1, 1) / factor
            if factor.denominator == 1:
                action = f"Умножим R{pivot_row + 1} на {_human_fraction(factor)}"
            elif divisor.denominator == 1 and divisor > 0:
                action = f"Разделим R{pivot_row + 1} на {_human_fraction(divisor)}"
            else:
                action = f"Умножим R{pivot_row + 1} на {_human_fraction(factor)}"
            perform(
                op,
                col,
                "normalize",
                "Делаем ведущую единицу",
                f"{action}, чтобы ведущий элемент стал равен 1.",
            )
        rows_to_clear = range(rows) if goal == "rref" else range(pivot_row + 1, rows)
        for r in rows_to_clear:
            if r == pivot_row:
                continue
            value = work[r][col]
            if value == 0:
                continue
            if value > 0:
                op = RowOp("subtract", pivot_row, r, value)
                verb = f"Вычтем {format_fraction(value)}·R{pivot_row + 1}"
            else:
                op = RowOp("add", pivot_row, r, -value)
                verb = f"Прибавим {format_fraction(-value)}·R{pivot_row + 1}"
            perform(
                op,
                col,
                "eliminate",
                "Обнуляем элемент",
                f"{verb} {'из' if value > 0 else 'к'} R{r + 1}: в столбце {col + 1} появится ноль.",
            )
        pivot_row += 1

    return steps


def _variable_name(index: int) -> str:
    if index < len(VARIABLE_NAMES):
        return VARIABLE_NAMES[index]
    return f"x{index + 1}"


def analyze(board: Sequence[Sequence[Fraction]], augmented: int, goal: GoalKind) -> dict[str, Any]:
    if goal == "inverse":
        return _inverse_analysis(board, augmented, goal)
    if goal == "equation":
        return _equation_analysis(board, augmented, goal)

    rows = len(board)
    cols = len(board[0])
    coeff_cols = cols - augmented
    coeff_rank = matrix_rank(board, coeff_cols)
    aug_rank = matrix_rank(board, cols) if augmented else coeff_rank
    consistent = aug_rank == coeff_rank
    free_variables = max(coeff_cols - coeff_rank, 0) if consistent else 0
    plan = _plan(board, augmented, goal)

    if augmented == 0:
        status = "Ранг матрицы"
        status_detail = f"rank = {coeff_rank}"
    elif not consistent:
        status = "Несовместна"
        status_detail = "решений нет"
    elif free_variables == 0:
        status = "Совместна"
        status_detail = "единственное решение"
    else:
        status = "Совместна"
        word = "свободная переменная" if free_variables == 1 else "свободные переменные"
        status_detail = f"{free_variables} {word}"

    solution: list[dict[str, str]] | None = None
    if augmented == 1 and consistent and free_variables == 0:
        reduced, pivots = _rank_and_pivots(board, cols)
        solution = []
        for row, col in pivots:
            if col >= coeff_cols:
                solution = None
                break
            solution.append(
                {
                    "name": _variable_name(col),
                    "value": format_fraction(reduced[row][cols - 1]),
                }
            )

    _, coeff_pivots = _rank_and_pivots(board, coeff_cols)
    pivot_columns = [col for _, col in coeff_pivots]
    zero_rows = sum(1 for row in board if all(cell == 0 for cell in row))

    return {
        "rows": rows,
        "cols": cols,
        "coefficient_cols": coeff_cols,
        "augmented": augmented,
        "mode": "system",
        "goal": goal,
        "goal_label": GOAL_LABELS[goal],
        "goal_met": len(plan) == 0,
        "remaining_steps": len(plan),
        "rank": coeff_rank,
        "augmented_rank": aug_rank,
        "consistent": consistent,
        "free_variables": free_variables,
        "zero_rows": zero_rows,
        "pivot_columns": pivot_columns,
        "variable_names": [_variable_name(i) for i in range(coeff_cols)],
        "status": status,
        "status_detail": status_detail,
        "solution": solution,
    }


def _step_payload(step: PlannedStep) -> dict[str, Any]:
    return {
        **operation_payload(step.op),
        "expression": operation_expression(step.op),
        "col": step.col,
        "reason": step.reason,
        "title": step.title,
        "why": step.why,
    }


def operation_result(
    board: Sequence[Sequence[Fraction]],
    augmented: int,
    goal: GoalKind,
    op: RowOp,
) -> dict[str, Any]:
    result, changed = apply_row_op(board, op)
    zeros_created = 0 if op.kind == "swap" else sum(1 for cell in changed if cell["zeroed"])
    analysis = analyze(result, augmented, goal)
    return {
        "matrix": serialize_board(result),
        "changed": changed,
        "zeros_created": zeros_created,
        "expression": operation_expression(op),
        "description": _describe(op),
        "analysis": analysis,
    }


def _describe(op: RowOp) -> str:
    if op.kind == "swap":
        return f"Строки R{op.source + 1} и R{op.target + 1} поменялись местами."
    if op.kind == "scale":
        return f"Строка R{op.target + 1} умножена на {format_fraction(op.factor)}."
    verb = "вычтена" if op.kind == "subtract" else "прибавлена"
    return (
        f"{format_fraction(op.factor)}·R{op.source + 1} {verb} "
        f"{'из' if op.kind == 'subtract' else 'к'} R{op.target + 1}."
    )


def hint(board: Sequence[Sequence[Fraction]], augmented: int, goal: GoalKind) -> dict[str, Any]:
    if goal == "inverse":
        left, _ = _inverse_parts(board, augmented)
        determinant = _determinant(left, len(left))
        identity = _is_identity(left)
        if identity:
            return {
                "available": False,
                "goal_met": True,
                "invertible": True,
                "title": "A⁻¹ уже найдена",
                "why": "Слева стоит единичная матрица, справа — обратная. "
                "Можно собрать новую матрицу A.",
                "remaining_steps": 0,
            }
        if determinant == 0:
            return {
                "available": False,
                "goal_met": False,
                "invertible": False,
                "title": "Обратной не существует",
                "why": "det A = 0: строки линейно зависимы, поэтому привести "
                "левую часть к I невозможно.",
                "remaining_steps": 0,
            }
        plan = _plan(board, augmented, "rref")
    elif goal == "equation":
        left, _ = _equation_parts(board, augmented)
        determinant = _determinant(left, len(left))
        identity = _is_identity(left)
        if identity:
            return {
                "available": False,
                "goal_met": True,
                "invertible": True,
                "title": "X уже найден",
                "why": "Слева стоит I, справа — решение X = A⁻¹B. Можно составить новое уравнение.",
                "remaining_steps": 0,
            }
        if determinant == 0:
            rank_left = matrix_rank(board, len(left))
            rank_augmented = matrix_rank(board, len(board[0]))
            if rank_augmented > rank_left:
                why = "A вырождена, и ранг [A | B] больше ранга A: уравнение A·X = B несовместно."
            else:
                why = (
                    "A вырождена: решение существует, но не единственно — "
                    "привести левую часть к I невозможно."
                )
            consistent_equation = rank_augmented == rank_left
            return {
                "available": False,
                "goal_met": False,
                "invertible": False,
                "consistent": consistent_equation,
                "title": "Решений нет" if not consistent_equation else "Бесконечно много решений",
                "why": why,
                "remaining_steps": 0,
            }
        plan = _plan(board, augmented, "rref")
    else:
        plan = _plan(board, augmented, goal)

    if not plan:
        return {
            "available": False,
            "goal_met": True,
            "title": "Цель достигнута",
            "why": "Матрица уже имеет нужный вид. Можно выбрать другой вызов "
            "или увеличить размерность.",
            "remaining_steps": 0,
        }
    first = plan[0]
    return {
        "available": True,
        "goal_met": False,
        "op": operation_payload(first.op),
        "expression": operation_expression(first.op),
        "title": first.title,
        "why": first.why,
        "col": first.col,
        "remaining_steps": len(plan),
    }


def solve(board: Sequence[Sequence[Fraction]], augmented: int, goal: GoalKind) -> dict[str, Any]:
    if goal == "inverse":
        left, _ = _inverse_parts(board, augmented)
        determinant = _determinant(left, len(left))
        identity = _is_identity(left)
        plan = [] if determinant == 0 or identity else _plan(board, augmented, "rref")
    elif goal == "equation":
        left, _ = _equation_parts(board, augmented)
        determinant = _determinant(left, len(left))
        identity = _is_identity(left)
        plan = [] if determinant == 0 or identity else _plan(board, augmented, "rref")
    else:
        plan = _plan(board, augmented, goal)
    work = [list(row) for row in board]
    steps: list[dict[str, Any]] = []
    for planned in plan:
        work, changed = apply_row_op(work, planned.op)
        steps.append(
            {
                **_step_payload(planned),
                "matrix": serialize_board(work),
                "changed": changed,
                "zeros_created": 0
                if planned.op.kind == "swap"
                else sum(1 for cell in changed if cell["zeroed"]),
            }
        )
    return {
        "steps": steps,
        "matrix": serialize_board(work),
        "analysis": analyze(work, augmented, goal),
        "count": len(steps),
    }


PRESETS: list[dict[str, Any]] = [
    {
        "id": "classic",
        "name": "Классика 3×3",
        "note": "Единственное решение",
        "accent": "violet",
        "augmented": 1,
        "goal": "echelon",
        "matrix": [
            ["2", "1", "-1", "8"],
            ["-3", "-1", "2", "-11"],
            ["-2", "1", "2", "-3"],
        ],
    },
    {
        "id": "free",
        "name": "Свободная переменная",
        "note": "Бесконечно много решений",
        "accent": "cyan",
        "augmented": 1,
        "goal": "echelon",
        "matrix": [
            ["1", "1", "1", "3"],
            ["2", "2", "2", "6"],
            ["1", "-1", "1", "1"],
        ],
    },
    {
        "id": "trap",
        "name": "Ловушка",
        "note": "Система без решения",
        "accent": "coral",
        "augmented": 1,
        "goal": "echelon",
        "matrix": [
            ["1", "2", "3", "4"],
            ["2", "4", "6", "9"],
            ["1", "1", "1", "1"],
        ],
    },
    {
        "id": "almost",
        "name": "Почти готово",
        "note": "Разминка на 3 хода",
        "accent": "lime",
        "augmented": 1,
        "goal": "echelon",
        "matrix": [
            ["1", "2", "0", "3"],
            ["0", "1", "1", "2"],
            ["0", "2", "1", "5"],
        ],
    },
    {
        "id": "challenge",
        "name": "Вызов 4×4",
        "note": "Полный разбор",
        "accent": "amber",
        "augmented": 1,
        "goal": "rref",
        "matrix": [
            ["1", "1", "1", "1", "2"],
            ["2", "-1", "1", "0", "4"],
            ["1", "2", "-1", "1", "0"],
            ["3", "1", "2", "-1", "-2"],
        ],
    },
]
