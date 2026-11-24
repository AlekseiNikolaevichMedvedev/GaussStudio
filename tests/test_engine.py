from __future__ import annotations

from fractions import Fraction

import pytest

from gauss_studio.engine import (
    PRESETS,
    MatrixError,
    RowOp,
    analyze,
    apply_row_op,
    format_fraction,
    hint,
    matrix_rank,
    operation_result,
    parse_fraction,
    read_board,
    read_operation,
    serialize_board,
    solve,
)


def test_parse_fraction_supports_classroom_notation():
    assert parse_fraction("2") == 2
    assert parse_fraction("-3/4") == Fraction(-3, 4)
    assert parse_fraction("0.25") == Fraction(1, 4)
    assert parse_fraction("1,5") == Fraction(3, 2)
    assert parse_fraction("−1 1/2") == Fraction(-3, 2)
    assert parse_fraction("") == 0


def test_parse_fraction_rejects_bad_values():
    with pytest.raises(MatrixError):
        parse_fraction("1/0")
    with pytest.raises(MatrixError):
        parse_fraction("hello")
    with pytest.raises(MatrixError):
        parse_fraction("1" * 33)


def test_subtraction_is_exact():
    board, _ = read_board([["2", "1", "8"], ["-3", "-1", "-11"]], 1)
    result, changed = apply_row_op(board, RowOp("subtract", 0, 1, Fraction(3, 2)))
    assert serialize_board(result) == [["2", "1", "8"], ["-6", "-5/2", "-23"]]
    assert {cell["col"] for cell in changed} == {0, 1, 2}
    assert all(cell["old"] != cell["new"] for cell in changed)


def test_swap_and_scale():
    board, _ = read_board([["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]], 0)
    swapped, changed = apply_row_op(board, RowOp("swap", 0, 2))
    assert serialize_board(swapped)[0] == ["7", "8", "9"]
    assert {cell["row"] for cell in changed} == {0, 2}
    scaled, _ = apply_row_op(board, RowOp("scale", 0, 0, Fraction(-1, 2)))
    assert serialize_board(scaled)[0] == ["-1/2", "-1", "-3/2"]


def test_operation_validation():
    with pytest.raises(MatrixError):
        read_operation("subtract", 0, 0, "1", 3)
    with pytest.raises(MatrixError):
        read_operation("scale", 1, 1, "0", 3)
    with pytest.raises(MatrixError):
        read_operation("swap", 2, 2, None, 3)
    with pytest.raises(MatrixError):
        read_operation("weird", 0, 1, "1", 3)


def test_rank_and_unique_solution():
    board, augmented = read_board(
        [["2", "1", "-1", "8"], ["-3", "-1", "2", "-11"], ["-2", "1", "2", "-3"]],
        1,
    )
    report = analyze(board, augmented, "echelon")
    assert report["rank"] == 3
    assert report["goal_met"] is False
    assert report["solution"] == [
        {"name": "x", "value": "2"},
        {"name": "y", "value": "3"},
        {"name": "z", "value": "-1"},
    ]
    result = solve(board, augmented, "echelon")
    assert result["analysis"]["goal_met"] is True


def test_inconsistent_system():
    board, augmented = read_board(
        [["1", "2", "3", "4"], ["2", "4", "6", "9"], ["1", "1", "1", "1"]], 1
    )
    report = analyze(board, augmented, "echelon")
    assert report["consistent"] is False
    assert report["augmented_rank"] > report["rank"]
    solved = solve(board, augmented, "rref")
    assert solved["analysis"]["goal_met"] is True
    assert solved["analysis"]["consistent"] is False


def test_free_variables():
    board, augmented = read_board(
        [["1", "1", "1", "3"], ["2", "2", "2", "6"], ["1", "-1", "1", "1"]], 1
    )
    report = analyze(board, augmented, "echelon")
    assert report["consistent"] is True
    assert report["free_variables"] == 1
    assert report["solution"] is None


def _assert_echelon(matrix: list[list[str]], coefficient_cols: int, rref: bool) -> None:
    values = [[parse_fraction(cell) for cell in row] for row in matrix]
    leading_columns: list[int] = []
    zero_row_seen = False
    for row in values:
        leading = next((i for i in range(coefficient_cols) if row[i] != 0), None)
        if leading is None:
            assert all(cell == 0 for cell in row[:coefficient_cols])
            zero_row_seen = True
            continue
        assert not zero_row_seen, "A non-zero row follows a zero row"
        assert leading_columns == [] or leading > leading_columns[-1]
        assert row[leading] == 1
        leading_columns.append(leading)

    for pivot_row, column in enumerate(leading_columns):
        below = [values[row][column] for row in range(pivot_row + 1, len(values))]
        assert all(value == 0 for value in below)
        if rref:
            above = [values[row][column] for row in range(pivot_row)]
            assert all(value == 0 for value in above)


@pytest.mark.parametrize("preset", PRESETS, ids=lambda preset: preset["id"])
@pytest.mark.parametrize("goal", ["echelon", "rref"])
def test_every_preset_reaches_every_goal(preset, goal):
    board, augmented = read_board(preset["matrix"], preset["augmented"])
    result = solve(board, augmented, goal)
    assert result["count"] > 0
    assert result["analysis"]["goal_met"] is True
    _assert_echelon(result["matrix"], len(board[0]) - augmented, rref=goal == "rref")
    assert result["analysis"]["remaining_steps"] == 0


def test_every_operation_changes_something():
    board, _ = read_board([["1", "2", "4"], ["0", "1", "3"], ["2", "0", "1"]], 0)
    for op in [
        RowOp("swap", 0, 1),
        RowOp("scale", 0, 0, Fraction(1, 2)),
        RowOp("add", 0, 1, Fraction(2)),
        RowOp("subtract", 1, 2, Fraction(3)),
    ]:
        result, changed = apply_row_op(board, op)
        assert result != board
        assert changed


def test_swap_does_not_report_created_zeros():
    board, augmented = read_board([["1", "0", "3"], ["0", "5", "6"]], 0)
    result = operation_result(board, augmented, "echelon", RowOp("swap", 0, 1))
    assert result["zeros_created"] == 0
    assert {cell["row"] for cell in result["changed"]} == {0, 1}


def test_rank_of_zero_matrix():
    board, _ = read_board([["0", "0"], ["0", "0"]], 0)
    assert matrix_rank(board, 2) == 0
    report = analyze(board, 0, "echelon")
    assert report["goal_met"] is True
    assert report["rank"] == 0


def test_hint_is_a_real_operation():
    board, augmented = read_board(PRESETS[0]["matrix"], 1)
    result = hint(board, augmented, "echelon")
    assert result["available"] is True
    assert result["remaining_steps"] >= 1
    op = result["op"]
    assert op["kind"] in {"subtract", "add", "swap", "scale"}
    parsed = read_operation(op["kind"], op["source"], op["target"], op["factor"], len(board))
    changed_board, _ = apply_row_op(board, parsed)
    assert changed_board != board


def test_no_augmented_column():
    board, augmented = read_board([["1", "2", "3"], ["2", "4", "6"]], 0)
    assert augmented == 0
    report = analyze(board, 0, "rref")
    assert report["rank"] == 1
    assert report["pivot_columns"] == [0]


INVERSE_A = [["1", "2", "3"], ["0", "1", "4"], ["5", "6", "0"]]
INVERSE_EXPECTED = [["-24", "18", "5"], ["20", "-15", "-4"], ["-5", "4", "1"]]


def _with_identity(matrix: list[list[str]]) -> list[list[str]]:
    size = len(matrix)
    identity = [[str(int(row == column)) for column in range(size)] for row in range(size)]
    return [row + identity[index] for index, row in enumerate(matrix)]


def test_inverse_mode_reaches_identity():
    board, augmented = read_board(_with_identity(INVERSE_A), 3)
    report = analyze(board, augmented, "inverse")
    assert report["mode"] == "inverse"
    assert report["invertible"] is True
    assert report["determinant"] == "1"
    assert report["goal_met"] is False
    assert report["remaining_steps"] > 0
    assert report["inverse"] is None

    hint_result = hint(board, augmented, "inverse")
    assert hint_result["available"] is True

    solved = solve(board, augmented, "inverse")
    assert solved["analysis"]["goal_met"] is True
    assert solved["analysis"]["inverse"] == INVERSE_EXPECTED
    _assert_echelon(solved["matrix"], 3, rref=True)
    for row in range(3):
        for column in range(3):
            assert solved["matrix"][row][column] == ("1" if row == column else "0")


def test_inverse_reports_original_determinant_after_completion():
    matrix = [
        ["2", "1", "-1", "1", "0", "0"],
        ["-3", "-1", "2", "0", "1", "0"],
        ["-2", "1", "2", "0", "0", "1"],
    ]
    board, augmented = read_board(matrix, 3)
    solved = solve(board, augmented, "inverse")
    assert solved["analysis"]["goal_met"] is True
    assert solved["analysis"]["determinant"] == "-1"
    assert solved["analysis"]["inverse"] == [
        ["4", "3", "-1"],
        ["-2", "-2", "1"],
        ["5", "4", "-1"],
    ]


def test_inverse_of_identity_is_immediate():
    board, augmented = read_board(_with_identity([["1", "0"], ["0", "1"]]), 2)
    report = analyze(board, augmented, "inverse")
    assert report["goal_met"] is True
    assert report["inverse"] == [["1", "0"], ["0", "1"]]
    assert solve(board, augmented, "inverse")["count"] == 0


def test_singular_matrix_has_no_inverse():
    board, augmented = read_board(_with_identity([["1", "2"], ["2", "4"]]), 2)
    report = analyze(board, augmented, "inverse")
    assert report["invertible"] is False
    assert report["determinant"] == "0"
    assert report["goal_met"] is False
    assert report["inverse"] is None

    result = hint(board, augmented, "inverse")
    assert result["available"] is False
    assert result["invertible"] is False
    assert solve(board, augmented, "inverse")["count"] == 0


def test_inverse_mode_accepts_eight_by_eight_board():
    size = 8
    matrix = []
    for row in range(size):
        line = [str(int(row == column)) for column in range(size)]
        matrix.append(line + line)
    board, augmented = read_board(matrix, size)
    assert len(board) == 8
    assert len(board[0]) == 16
    assert analyze(board, augmented, "inverse")["goal_met"] is True


EQUATION_BOARD = [
    ["2", "1", "1", "0"],
    ["1", "3", "0", "1"],
]


def test_equation_mode_solves_ax_equals_b():
    board, augmented = read_board(EQUATION_BOARD, 2)
    report = analyze(board, augmented, "equation")
    assert report["mode"] == "equation"
    assert report["invertible"] is True
    assert report["determinant"] == "5"
    assert report["goal_met"] is False
    assert hint(board, augmented, "equation")["available"] is True

    solved = solve(board, augmented, "equation")
    assert solved["analysis"]["goal_met"] is True
    assert solved["analysis"]["solution_matrix"] == [
        ["3/5", "-1/5"],
        ["-1/5", "2/5"],
    ]
    assert solved["matrix"][0][:2] == ["1", "0"]
    assert solved["matrix"][1][:2] == ["0", "1"]


def test_equation_singular_inconsistent():
    board, augmented = read_board([["1", "2", "1"], ["2", "4", "0"]], 1)
    report = analyze(board, augmented, "equation")
    assert report["invertible"] is False
    assert report["consistent"] is False
    assert report["goal_met"] is False
    assert report["free_variables"] == 0
    unavailable = hint(board, augmented, "equation")
    assert unavailable["available"] is False
    assert unavailable["consistent"] is False
    assert solve(board, augmented, "equation")["count"] == 0


def test_equation_singular_consistent_has_infinite_solutions():
    board, augmented = read_board([["1", "2", "1"], ["2", "4", "2"]], 1)
    report = analyze(board, augmented, "equation")
    assert report["invertible"] is False
    assert report["consistent"] is True
    assert report["free_variables"] == 1
    unavailable = hint(board, augmented, "equation")
    assert unavailable["available"] is False
    assert unavailable["consistent"] is True
    assert solve(board, augmented, "equation")["count"] == 0


def test_equation_with_identity_left_is_solved():
    board, augmented = read_board([["1", "0", "4"], ["0", "1", "-2"]], 1)
    report = analyze(board, augmented, "equation")
    assert report["goal_met"] is True
    assert report["solution_matrix"] == [["4"], ["-2"]]


def test_format_fraction():
    assert format_fraction(Fraction(3)) == "3"
    assert format_fraction(Fraction(-3, 4)) == "-3/4"
