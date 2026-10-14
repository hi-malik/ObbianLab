#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
from datetime import UTC, datetime, timedelta
import platform
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed


def percentile(values: list[float], p: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, int((len(ordered) - 1) * p))
    return ordered[index]


def call(_: int) -> tuple[int, float]:
    payload = json.dumps({
        "categoryId": "55555555-5555-4555-8555-555555555551",
        "latitude": 28.6139,
        "longitude": 77.2090,
        "scheduledFor": (datetime.now(UTC)+timedelta(days=60)).isoformat(),
        "durationMinutes": 60,
    }).encode()
    request = urllib.request.Request(
        "http://localhost:3001/availability/check", data=payload, method="POST",
        headers={
            "content-type": "application/json",
            "x-tenant-id": "11111111-1111-4111-8111-111111111111",
            "x-actor-id": "22222222-2222-4222-8222-222222222222",
        },
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            response.read()
            return response.status, (time.perf_counter() - started) * 1000
    except Exception:
        return 0, (time.perf_counter() - started) * 1000


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--requests", type=int, default=1000)
    parser.add_argument("--concurrency", type=int, default=25)
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.requests < 1 or args.concurrency < 1: parser.error("requests and concurrency must be positive")
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        results = [future.result() for future in as_completed(
            executor.submit(call, number) for number in range(args.requests)
        )]
    elapsed = time.perf_counter() - started
    latencies = [latency for _, latency in results]
    report = {
        "workload": "POST /availability/check",
        "recorded_at": datetime.now(UTC).isoformat(),
        "environment": platform.platform(),
        "limitation": "Small seeded local dataset; HTTP success does not imply available capacity. Not an AWS or fleet-size capacity test.",
        "requests": args.requests,
        "concurrency": args.concurrency,
        "success": sum(status == 201 or status == 200 for status, _ in results),
        "errors": sum(status not in (200, 201) for status, _ in results),
        "duration_seconds": round(elapsed, 3),
        "requests_per_second": round(args.requests / elapsed, 2),
        "latency_ms": {
            "mean": round(statistics.mean(latencies), 2),
            "p50": round(percentile(latencies, .50), 2),
            "p95": round(percentile(latencies, .95), 2),
            "p99": round(percentile(latencies, .99), 2),
            "max": round(max(latencies), 2),
        },
    }
    rendered = json.dumps(report, indent=2)
    print(rendered)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as output:
            output.write(rendered + "\n")


if __name__ == "__main__":
    main()
