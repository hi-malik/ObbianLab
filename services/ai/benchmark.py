"""Measure the running AI service's text clarification latency using an isolated identity.

DATABASE_URL=... AI_BENCH_URL=http://ai:8000 AI_DEMO_TOKEN=... python benchmark.py
No booking is created. Temporary conversations, audits, user and tenant are removed.
"""
import asyncio
import json
import math
import os
import statistics
import time
from uuid import uuid4

import asyncpg
import httpx


async def main():
    pool = await asyncpg.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    tenant, actor = uuid4(), uuid4()
    samples = []
    try:
        await pool.execute("INSERT INTO tenants(id,name) VALUES($1,'AI latency benchmark')", tenant)
        await pool.execute("INSERT INTO app_users(id,tenant_id,external_subject,display_name,roles) VALUES($1,$2,$3,'Benchmark',ARRAY['customer'])", actor, tenant, str(actor))
        headers = {"authorization": f"Bearer {os.environ['AI_DEMO_TOKEN']}", "x-tenant-id": str(tenant), "x-actor-id": str(actor)}
        async with httpx.AsyncClient(base_url=os.getenv("AI_BENCH_URL", "http://ai:8000"), timeout=10) as client:
            for index in range(55):
                started = time.perf_counter()
                reply = await client.post("/agent/messages", headers=headers, json={"message": "electrician"})
                elapsed = (time.perf_counter() - started) * 1000
                reply.raise_for_status()
                assert reply.json()["stage"] == "collecting"
                assert "address" in reply.json()["required_fields"]
                if index >= 5:
                    samples.append(elapsed)
        print(json.dumps({
            "scenario": 3, "mode": "offline deterministic intent; live HTTP + auth + PostgreSQL state and audit",
            "workload": "new conversation / electrician / address clarification; sequential; 5 warmups excluded",
            "samples": len(samples), "latency_ms_p50": round(statistics.median(samples), 3),
            "latency_ms_p95": round(sorted(samples)[math.ceil(len(samples) * .95) - 1], 3),
            "latency_ms_max": round(max(samples), 3),
            "limitations": "Local Docker host, no LLM, no ASR, no create-booking call; not a load or scalability result",
        }, indent=2))
    finally:
        await pool.execute("DELETE FROM ai_audit_events WHERE tenant_id=$1", tenant)
        await pool.execute("DELETE FROM ai_conversations WHERE tenant_id=$1", tenant)
        await pool.execute("DELETE FROM app_users WHERE tenant_id=$1", tenant)
        await pool.execute("DELETE FROM tenants WHERE id=$1", tenant)
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
