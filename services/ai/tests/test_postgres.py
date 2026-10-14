"""Real pgvector / PostgreSQL security and durability tests.

Run with TEST_DATABASE_URL after applying db/migrations (including 005).
"""
import asyncio
import os
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import asyncpg
import pytest
import pytest_asyncio

from app.audit import PostgresAuditSink
from app.intent import DeterministicIntentModel
from app.models import Identity, Stage
from app.rag import DocumentInput, QueryInput, RagService
from app.state import PostgresStateStore
from app.workflow import BookingWorkflow
from test_workflow import FakeBackend

pytestmark = pytest.mark.skipif(not os.getenv("TEST_DATABASE_URL"), reason="TEST_DATABASE_URL required for live PostgreSQL tests")


@pytest_asyncio.fixture
async def database():
    pool = await asyncpg.create_pool(os.environ["TEST_DATABASE_URL"], min_size=1, max_size=4, command_timeout=10)
    tenant, actor = uuid4(), uuid4()
    await pool.execute("INSERT INTO tenants(id,name) VALUES($1,'AI integration test')", tenant)
    await pool.execute("INSERT INTO app_users(id,tenant_id,external_subject,display_name,roles) VALUES($1,$2,$3,'Test',ARRAY['knowledge_admin','customer'])", actor, tenant, str(actor))
    identity = Identity(tenant_id=tenant, actor_id=actor, roles=["knowledge_admin", "customer"])
    try:
        yield pool, identity
    finally:
        await pool.execute("DELETE FROM ai_audit_events WHERE tenant_id=$1", tenant)
        await pool.execute("DELETE FROM ai_conversations WHERE tenant_id=$1", tenant)
        await pool.execute("DELETE FROM knowledge_documents WHERE tenant_id=$1", tenant)
        await pool.execute("DELETE FROM app_users WHERE tenant_id=$1", tenant)
        await pool.execute("DELETE FROM tenants WHERE id=$1", tenant)
        await pool.close()


@pytest.mark.asyncio
async def test_actual_pgvector_acl_versions_and_hard_delete(database):
    pool, actor = database
    rag = RagService(pool)
    doc_id, version = await rag.ingest(actor, DocumentInput(external_key="electric", title="Safety manual", text="circuit breaker reset isolate electricity switch", allowed_roles=["customer"]))
    query = QueryInput(question="circuit breaker reset")
    reply = await rag.query(actor, query)
    assert reply.grounded and reply.citations[0].document_id == doc_id
    assert version == 1
    denied = await rag.query(actor.model_copy(update={"actor_id": uuid4(), "roles": ["professional"]}), query)
    assert not denied.grounded and not denied.citations
    other_tenant = await rag.query(actor.model_copy(update={"tenant_id": uuid4()}), query)
    assert not other_tenant.grounded
    _, version = await rag.ingest(actor, DocumentInput(external_key="electric", title="Updated", text="circuit breaker reset requires the updated safety interlock", allowed_users=[actor.actor_id]))
    reply = await rag.query(actor, query)
    assert version == 2
    assert reply.citations[0].version == 2
    assert "updated safety interlock" in reply.answer
    assert await rag.delete(actor, "electric")
    assert not (await rag.query(actor, query)).grounded
    assert await pool.fetchval("SELECT count(*) FROM knowledge_chunks WHERE document_id=$1", doc_id) == 0


@pytest.mark.asyncio
async def test_embedding_models_never_mix(database):
    pool, actor = database
    await RagService(pool).ingest(actor, DocumentInput(external_key="key", title="Title", text="breaker circuit reset", allowed_roles=["customer"]))
    class OtherEmbeddings:
        name = "a-different-model:384"
        async def embed(self, texts):
            return [[1.] * 384 for _ in texts]
    assert not (await RagService(pool, OtherEmbeddings()).query(actor, QueryInput(question="breaker circuit reset"))).grounded


@pytest.mark.asyncio
async def test_conversation_durable_across_instances_and_concurrent_requests(database):
    pool, actor = database
    backend = FakeBackend()
    first = BookingWorkflow(DeterministicIntentModel(), backend, PostgresAuditSink(pool), PostgresStateStore(pool))
    scheduled = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    proposal = await first.handle(actor, f"electrician address: 12 Lake Road; 28.6139,77.2090 on {scheduled}")
    assert proposal.stage == Stage.AWAITING_CONFIRMATION
    # New service objects simulate process restart; all state is reloaded from SQL.
    other = BookingWorkflow(DeterministicIntentModel(), backend, PostgresAuditSink(pool), PostgresStateStore(pool))
    replies = await asyncio.gather(*(workflow.handle(actor, "confirm", proposal.conversation_id) for workflow in (first, other, first, other, first, other)))
    assert backend.created == 1
    assert all(reply.stage == Stage.COMPLETED for reply in replies)
    state = await PostgresStateStore(pool).get(proposal.conversation_id)
    assert state.stage == Stage.COMPLETED
    assert await pool.fetchval("SELECT count(*) FROM ai_audit_events WHERE conversation_id=$1 AND decision='explicitly_confirmed'", proposal.conversation_id) == 2
