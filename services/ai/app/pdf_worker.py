"""Isolated PDF parser: resource limits apply only to this disposable subprocess."""
import resource
import sys

from .rag import extract_pdf


def main():
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    try:
        text = extract_pdf(sys.stdin.buffer.read(20_000_001))
        sys.stdout.write(text)
    except Exception:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
