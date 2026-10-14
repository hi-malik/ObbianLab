from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest

from app.audit import MemoryAuditSink
from app.intent import DeterministicIntentModel
from app.models import Identity, Stage
from app.workflow import BookingWorkflow, MemoryStateStore


class FakeBackend:
    def __init__(self):
        self.created = 0
        self.available = True

    async def category_id(self, identity, slug):
        return UUID("8b24dc93-0a03-4e1a-8867-0234520fc71f") if slug == "electrician" else None

    async def availability(self, identity, slots):
        return self.available

    async def create_booking(self, identity, slots, idempotency_key):
        self.created += 1
        return UUID("286f88e9-c3b5-480a-b9f8-352126e78c42")


@pytest.fixture
def setup():
    backend = FakeBackend()
    audit = MemoryAuditSink()
    workflow = BookingWorkflow(DeterministicIntentModel(), backend, audit, MemoryStateStore())
    identity = Identity(tenant_id=uuid4(), actor_id=uuid4(), roles=["customer"])
    return workflow, backend, audit, identity


@pytest.mark.asyncio
async def test_booking_requires_a_separate_explicit_confirmation(setup):
    workflow, backend, audit, identity = setup
    scheduled = (datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0).isoformat()
    first = await workflow.handle(
        identity,
        f"electrician at: 12 Lake Road; 28.6139,77.2090 on {scheduled}",
    )
    assert first.stage == Stage.AWAITING_CONFIRMATION
    assert backend.created == 0

    ambiguous = await workflow.handle(identity, "sounds good", first.conversation_id)
    assert ambiguous.stage == Stage.AWAITING_CONFIRMATION
    assert backend.created == 0

    confirmed = await workflow.handle(identity, "confirm", first.conversation_id)
    assert confirmed.stage == Stage.COMPLETED
    assert backend.created == 1
    assert any(event.get("decision") == "explicitly_confirmed" for event in audit.events)


@pytest.mark.asyncio
async def test_conversation_is_bound_to_actor(setup):
    workflow, _, _, identity = setup
    reply = await workflow.handle(identity, "electrician")
    other = Identity(tenant_id=identity.tenant_id, actor_id=uuid4())
    with pytest.raises(PermissionError):
        await workflow.handle(other, "confirm", reply.conversation_id)
