"""Small reproducible retrieval evaluation; cleans up its isolated tenant afterwards.

DATABASE_URL=... python evaluate.py [--output report.json]
This is a lexical/demo regression set, not a claim of production semantic quality.
"""
import argparse
import asyncio
import json
import os
import statistics
import math
import time
from pathlib import Path
from uuid import uuid4

import asyncpg

from app.models import Identity
from app.rag import DocumentInput, QueryInput, RagService


async def evaluate(output=None):
    data = json.loads((Path(__file__).parent / "evaluation/retrieval.json").read_text())
    pool = await asyncpg.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=2)
    actor = Identity(tenant_id=uuid4(), actor_id=uuid4(), roles=["customer"])
    cases, timings = [], []
    try:
        await pool.execute("INSERT INTO tenants(id,name) VALUES($1,'Ephemeral retrieval evaluation')", actor.tenant_id)
        await pool.execute("INSERT INTO app_users(id,tenant_id,external_subject,display_name) VALUES($1,$2,$3,'Evaluation')", actor.actor_id, actor.tenant_id, str(actor.actor_id))
        rag = RagService(pool)
        keys = {}
        for document in data["documents"]:
            document_id, _ = await rag.ingest(actor, DocumentInput(external_key=document["key"], title=document["title"], text=document["text"], allowed_roles=["customer"]))
            keys[document_id] = document["key"]
        for case in data["queries"]:
            start = time.perf_counter()
            results = await rag.retrieve(actor, QueryInput(question=case["question"], limit=3))
            timings.append((time.perf_counter() - start) * 1000)
            ranked = [keys[chunk.document_id] for chunk in results]
            rank = ranked.index(case["expected"]) + 1 if case["expected"] in ranked else None
            cases.append({**case, "retrieved": ranked, "rank": rank})
        forbidden = actor.model_copy(update={"roles": ["forbidden"], "actor_id": uuid4()})
        denied = await rag.query(forbidden, QueryInput(question="circuit breaker"))
        unrelated = await rag.query(actor, QueryInput(question="quasar nebula astronomy telescope"))
        report = {
            "mode": "hash-v1-384 / lexical reranking; synthetic regression set",
            "documents": len(data["documents"]), "queries": len(cases),
            "recall_at_3": sum(case["rank"] is not None for case in cases) / len(cases),
            "mrr_at_3": sum(1 / case["rank"] if case["rank"] else 0 for case in cases) / len(cases),
            "acl_leaks": int(bool(denied.citations)),
            "unanswerable_abstained": not unrelated.grounded,
            "latency_ms_p50": round(statistics.median(timings), 3),
            "latency_ms_p95": round(sorted(timings)[math.ceil(len(timings) * 0.95) - 1], 3),
            "latency_ms_max": round(max(timings), 3),
            "cases": cases,
        }
        rendered = json.dumps(report, indent=2, ensure_ascii=False)
        if output: Path(output).write_text(rendered + "\n")
        print(rendered)
        if report["recall_at_3"] < 1 or report["acl_leaks"] or not report["unanswerable_abstained"]:
            raise SystemExit("retrieval regression")
    finally:
        await pool.execute("DELETE FROM knowledge_documents WHERE tenant_id=$1", actor.tenant_id)
        await pool.execute("DELETE FROM app_users WHERE tenant_id=$1", actor.tenant_id)
        await pool.execute("DELETE FROM tenants WHERE id=$1", actor.tenant_id)
        await pool.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    asyncio.run(evaluate(parser.parse_args().output))
