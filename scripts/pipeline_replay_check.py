#!/usr/bin/env python3
"""Republish one processed outbox event and prove the reporting consumer is idempotent."""

from __future__ import annotations

import json
import subprocess
import time


def sql(statement: str) -> str:
    result = subprocess.run(
        [
            "docker", "compose", "exec", "-T", "database",
            "psql", "-U", "obbian", "-d", "obbian", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def counters() -> tuple[int, int, int, int, int, int]:
    row = sql(
        "SELECT COALESCE(sum(requested_count), 0), COALESCE(sum(completed_count), 0), "
        "COALESCE(sum(cancelled_count), 0), COALESCE(sum(gross_amount_minor), 0), "
        "COALESCE(sum(refund_amount_minor), 0), "
        "(SELECT count(*) FROM consumer_inbox WHERE consumer_name = 'reporting-v1') "
        "FROM daily_booking_metrics"
    )
    return tuple(map(int, row.split("|")))


def main() -> None:
    event_id = sql(
        "SELECT o.id FROM outbox_events o "
        "JOIN consumer_inbox i ON i.event_id = o.id AND i.consumer_name = 'reporting-v1' "
        "WHERE o.event_type = 'booking.requested' AND o.published_at IS NOT NULL "
        "ORDER BY o.occurred_at DESC LIMIT 1"
    )
    if not event_id:
        raise RuntimeError("no processed booking.requested event; run scripts/smoke.py first")

    before = counters()
    sql(f"UPDATE outbox_events SET published_at = NULL WHERE id = '{event_id}'::uuid")

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if sql(f"SELECT published_at IS NOT NULL FROM outbox_events WHERE id = '{event_id}'::uuid") == "t":
            break
        time.sleep(0.2)
    else:
        raise RuntimeError("outbox publisher did not republish the event within 10 seconds")

    # Wait for the group's committed offsets, proving it consumed the replay.
    # A fixed sleep could pass even when the consumer was stopped.
    subprocess.run([
        "docker", "compose", "exec", "-T", "pipeline", "node", "-e", r"""
const { Kafka } = require('kafkajs');
(async () => {
  const admin = new Kafka({ clientId: 'replay-verifier',
    brokers: (process.env.KAFKA_BROKERS || 'redpanda:9092').split(',') }).admin();
  await admin.connect();
  try {
    const topic = process.env.EVENT_TOPIC || 'domain-events.v1';
    const target = await admin.fetchTopicOffsets(topic);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const result = await admin.fetchOffsets({ groupId: process.env.CONSUMER_NAME || 'reporting-v1', topics: [topic] });
      if (target.every(t => BigInt(result[0].partitions.find(p => p.partition === t.partition)?.offset || '-1') >= BigInt(t.offset))) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('consumer did not commit replay within 20 seconds');
  } finally { await admin.disconnect(); }
})().catch(error => { console.error(String(error)); process.exitCode = 1; });
"""
    ], check=True, capture_output=True, text=True)
    after = counters()
    if after != before:
        raise RuntimeError(f"replay changed reporting state: before={before}, after={after}")
    print(json.dumps({
        "status": "passed",
        "replayed_event": event_id,
        "requested_count_before_after": [before[0], after[0]],
        "completed_cancelled_gross_refund_before": list(before[1:5]),
        "completed_cancelled_gross_refund_after": list(after[1:5]),
        "inbox_rows_before_after": [before[5], after[5]],
    }, indent=2))


if __name__ == "__main__":
    main()
