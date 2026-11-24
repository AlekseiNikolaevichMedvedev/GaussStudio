from __future__ import annotations

from fastapi.testclient import TestClient

from gauss_studio.app import app

client = TestClient(app)

CLASSIC = [["2", "1", "-1", "8"], ["-3", "-1", "2", "-11"], ["-2", "1", "2", "-3"]]
INVERSE_BOARD = [
    ["1", "2", "3", "1", "0", "0"],
    ["0", "1", "4", "0", "1", "0"],
    ["5", "6", "0", "0", "0", "1"],
]
EQUATION_BOARD = [
    ["2", "1", "1", "0"],
    ["1", "3", "0", "1"],
]


def test_health_and_presets():
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["status"] == "ok"

    presets = client.get("/api/presets")
    assert presets.status_code == 200
    payload = presets.json()
    assert len(payload["presets"]) >= 5
    assert "echelon" in payload["goals"]
    assert "inverse" in payload["goals"]


def test_index_and_assets():
    index = client.get("/")
    assert index.status_code == 200
    assert "Gauss Studio" in index.text
    assert "/static/app.js" in index.text

    css = client.get("/static/styles.css")
    assert css.status_code == 200
    assert "--violet" in css.text

    font = client.get("/static/fonts/manrope-cyrillic.woff2")
    assert font.status_code == 200


def test_operation_endpoint_is_exact():
    response = client.post(
        "/api/operation",
        json={
            "matrix": CLASSIC,
            "augmented": 1,
            "goal": "echelon",
            "op": "scale",
            "source": 0,
            "target": 0,
            "factor": "1/2",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["matrix"][0] == ["1", "1/2", "-1/2", "4"]
    assert payload["expression"] == "R1 × 1/2 → R1"
    assert payload["analysis"]["rank"] == 3


def test_operation_rejects_same_row():
    response = client.post(
        "/api/operation",
        json={
            "matrix": CLASSIC,
            "augmented": 1,
            "goal": "echelon",
            "op": "subtract",
            "source": 0,
            "target": 0,
            "factor": "1",
        },
    )
    assert response.status_code == 422
    assert "разными" in response.json()["detail"]


def test_operation_rejects_zero_scale():
    response = client.post(
        "/api/operation",
        json={
            "matrix": CLASSIC,
            "augmented": 1,
            "goal": "echelon",
            "op": "scale",
            "source": 0,
            "target": 0,
            "factor": "0",
        },
    )
    assert response.status_code == 422


def test_hint_endpoint():
    response = client.post(
        "/api/hint",
        json={"matrix": CLASSIC, "augmented": 1, "goal": "echelon"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["available"] is True
    assert payload["op"]["kind"]
    assert payload["why"]
    assert payload["analysis"]["goal_met"] is False


def test_solve_endpoint():
    response = client.post(
        "/api/solve",
        json={"matrix": CLASSIC, "augmented": 1, "goal": "rref"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["count"] >= 6
    assert payload["analysis"]["goal_met"] is True
    assert payload["analysis"]["solution"]


def test_analyze_validates_matrix_shape():
    response = client.post(
        "/api/analyze",
        json={"matrix": [["1", "2"], ["3"]], "augmented": 1, "goal": "echelon"},
    )
    assert response.status_code == 422
    assert "одинаковой" in response.json()["detail"]


def test_analyze_rejects_augmented_outside_matrix():
    response = client.post(
        "/api/analyze",
        json={"matrix": [["1", "2"]], "augmented": 2, "goal": "echelon"},
    )
    assert response.status_code == 422


def test_inverse_analyze_and_solve_endpoints():
    analyze_response = client.post(
        "/api/analyze",
        json={"matrix": INVERSE_BOARD, "augmented": 3, "goal": "inverse"},
    )
    assert analyze_response.status_code == 200
    analysis = analyze_response.json()
    assert analysis["mode"] == "inverse"
    assert analysis["invertible"] is True
    assert analysis["determinant"] == "1"

    solved = client.post(
        "/api/solve",
        json={"matrix": INVERSE_BOARD, "augmented": 3, "goal": "inverse"},
    )
    assert solved.status_code == 200
    payload = solved.json()
    assert payload["analysis"]["goal_met"] is True
    assert payload["analysis"]["inverse"] == [
        ["-24", "18", "5"],
        ["20", "-15", "-4"],
        ["-5", "4", "1"],
    ]


def test_inverse_operation_endpoint():
    response = client.post(
        "/api/operation",
        json={
            "matrix": INVERSE_BOARD,
            "augmented": 3,
            "goal": "inverse",
            "op": "scale",
            "source": 0,
            "target": 0,
            "factor": "1/2",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["analysis"]["mode"] == "inverse"
    assert payload["analysis"]["goal_met"] is False
    assert payload["matrix"][0][:3] == ["1/2", "1", "3/2"]


def test_equation_solve_endpoint():
    response = client.post(
        "/api/solve",
        json={"matrix": EQUATION_BOARD, "augmented": 2, "goal": "equation"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["analysis"]["goal_met"] is True
    assert payload["analysis"]["mode"] == "equation"
    assert payload["analysis"]["solution_matrix"] == [
        ["3/5", "-1/5"],
        ["-1/5", "2/5"],
    ]


def test_equation_requires_square_a_and_b():
    response = client.post(
        "/api/analyze",
        json={"matrix": CLASSIC, "augmented": 2, "goal": "equation"},
    )
    assert response.status_code == 422
    assert "A·X = B" in response.json()["detail"]

    no_b = client.post(
        "/api/analyze",
        json={
            "matrix": [["1", "0"], ["0", "1"]],
            "augmented": 0,
            "goal": "equation",
        },
    )
    assert no_b.status_code == 422


def test_inverse_requires_identity_right_block():
    response = client.post(
        "/api/analyze",
        json={"matrix": CLASSIC, "augmented": 1, "goal": "inverse"},
    )
    assert response.status_code == 422
    assert "[A | I]" in response.json()["detail"]


def test_inverse_singular_hint_is_unavailable():
    response = client.post(
        "/api/hint",
        json={
            "matrix": [["1", "2", "1", "0"], ["2", "4", "0", "1"]],
            "augmented": 2,
            "goal": "inverse",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["available"] is False
    assert payload["invertible"] is False


def test_operation_requires_two_rows():
    response = client.post(
        "/api/operation",
        json={
            "matrix": [["1", "2"]],
            "augmented": 1,
            "goal": "echelon",
            "op": "scale",
            "source": 0,
            "target": 0,
            "factor": "2",
        },
    )
    assert response.status_code == 422
