from __future__ import annotations

import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="gauss-studio",
        description="Локальная студия элементарных преобразований матриц.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="Адрес сервера")
    parser.add_argument("--port", type=int, default=8765, help="Порт")
    parser.add_argument("--reload", action="store_true", help="Автоперезагрузка для разработки")
    args = parser.parse_args()

    if args.reload:
        uvicorn.run(
            "gauss_studio.app:app",
            host=args.host,
            port=args.port,
            reload=True,
            reload_dirs=["src"],
        )
    else:
        from .app import app

        uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
