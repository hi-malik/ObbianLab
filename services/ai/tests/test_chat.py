import asyncio
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest

from app.audit import MemoryAuditSink
from app.chat import ChatBookingSlots, ChatDecision, HostedChatModel
from app.intent import DeterministicIntentModel
from app.models import ChatTurn, ConversationState, Identity, Stage
from app.state import MemoryStateStore
from app.workflow import BookingWorkflow
from test_workflow import FakeBackend


class ChatModel:
    def __init__(self):
        self.decision = ChatDecision(route="chat", preferred_language="en", reply="How can I help?")
        self.seen = []
        self.fail_plan = False
        self.fail_response = False

    async def plan(self, text, state):
        self.seen.append(state.model_copy(deep=True))
        if self.fail_plan:
            raise httpx.ReadTimeout("provider timed out")
        return self.decision.model_copy(deep=True)

    async def respond(self, text, state, result):
        if self.fail_response:
            raise httpx.ReadTimeout("provider timed out after action")
        return "Here is the verified update."


def setup_chat():
    model, backend, states = ChatModel(), FakeBackend(), MemoryStateStore()
    workflow = BookingWorkflow(DeterministicIntentModel(), backend, MemoryAuditSink(), states, model)
    actor = Identity(tenant_id=uuid4(), actor_id=uuid4(), roles=["customer"])
    return workflow, model, backend, states, actor


def booking_decision():
    return ChatDecision(route="booking", preferred_language="en", reply="Checking your request.",
        slots=ChatBookingSlots(category="electrician", address="12 Lake Road", latitude=28.6139,
            longitude=77.2090, scheduled_for=datetime.now(UTC) + timedelta(days=1)))


@pytest.mark.asyncio
async def test_general_chat_ignores_slots_and_preserves_language_context():
    workflow, model, backend, states, actor = setup_chat()
    # Even erroneous slots on a chat decision cannot begin a booking.
    model.decision = booking_decision().model_copy(update={"route": "chat", "preferred_language": "hinglish"})
    first = await workflow.handle(actor, "My name is Arjun; use Hinglish.")
    second = await workflow.handle(actor, "What is my name?", first.conversation_id)
    state = await states.get(second.conversation_id)
    assert state.slots.category is None and backend.created == 0
    assert first.required_fields == [] and first.booking_update is None
    assert model.seen[1].preferred_language == "hinglish"
    assert model.seen[1].history[0].content == "My name is Arjun; use Hinglish."
    assert len(state.history) == 4
    other = Identity(tenant_id=actor.tenant_id, actor_id=uuid4())
    with pytest.raises(PermissionError):
        await workflow.handle(other, "What is my name?", first.conversation_id)
    await workflow.handle(actor, "Fresh conversation")
    assert model.seen[-1].history == []


@pytest.mark.asyncio
async def test_chat_detour_keeps_proposal_and_confirm_bypasses_model():
    workflow, model, backend, states, actor = setup_chat()
    model.decision = booking_decision()
    proposal = await workflow.handle(actor, "Please book the electrician.")
    before = (await states.get(proposal.conversation_id)).slots.model_copy(deep=True)
    assert proposal.stage == Stage.AWAITING_CONFIRMATION and backend.created == 0
    assert "confirm" in proposal.booking_update
    model.decision = ChatDecision(route="chat", preferred_language="en", reply="RAM is working memory.")
    await workflow.handle(actor, "What is RAM?", proposal.conversation_id)
    assert (await states.get(proposal.conversation_id)).slots == before
    assert backend.created == 0
    # Provider failure must not lose a committed booking or permit duplicates.
    model.fail_plan = model.fail_response = True
    results = await asyncio.gather(*(workflow.handle(actor, "confirm", proposal.conversation_id) for _ in range(5)))
    assert backend.created == 1
    assert all(result.stage == Stage.COMPLETED for result in results)
    assert all(result.booking_id for result in results)
    assert "assignment is pending" in results[0].booking_update


@pytest.mark.asyncio
async def test_provider_failure_does_not_change_draft_or_execute_actions():
    workflow, model, backend, states, actor = setup_chat()
    model.decision = booking_decision()
    proposal = await workflow.handle(actor, "Please book the electrician.")
    original = (await states.get(proposal.conversation_id)).slots.model_copy(deep=True)
    model.fail_plan = True
    failure = await workflow.handle(actor, "Change the address", proposal.conversation_id)
    assert failure.stage == Stage.AWAITING_CONFIRMATION and backend.created == 0
    assert (await states.get(proposal.conversation_id)).slots == original
    # Exact cancellation also works while the generation provider is unavailable.
    cancelled = await workflow.handle(actor, "cancel", proposal.conversation_id)
    assert cancelled.stage == Stage.CANCELLED and backend.created == 0


@pytest.mark.asyncio
async def test_conversation_history_is_bounded_by_messages_and_characters():
    workflow, model, _, states, actor = setup_chat()
    model.decision.reply = "A" * 4000
    conversation = None
    for _ in range(14):
        reply = await workflow.handle(actor, "Q" * 4000, conversation)
        conversation = reply.conversation_id
    state = await states.get(conversation)
    assert len(state.history) <= 20
    assert sum(len(turn.content) for turn in state.history) <= 24000
    assert state.history[0].role == "user" and state.history[-1].role == "assistant"


@pytest.mark.asyncio
async def test_uncertain_booking_stays_recoverable_with_chat_provider_down():
    workflow, model, backend, states, actor = setup_chat()
    model.decision = booking_decision()
    proposal = await workflow.handle(actor, "Please book an electrician")
    state = await states.get(proposal.conversation_id)
    state.stage = Stage.FAILED
    await states.put(state)
    model.fail_plan = True
    blocked = await workflow.handle(actor, "cancel", proposal.conversation_id)
    assert blocked.stage == Stage.FAILED and backend.created == 0
    recovered = await workflow.handle(actor, "retry", proposal.conversation_id)
    assert recovered.stage == Stage.COMPLETED and backend.created == 1


@pytest.mark.asyncio
async def test_hosted_chat_sends_history_and_validates_structured_decision():
    state = ConversationState(tenant_id=uuid4(), actor_id=uuid4(), preferred_language="en",
        history=[ChatTurn(role="user", content="My name is Arjun."),
                 ChatTurn(role="assistant", content="Hello, Arjun.")])
    decision = ChatDecision(route="chat", preferred_language="en", reply="Your name is Arjun.")
    model = HostedChatModel("https://models.example", "test-secret", "gpt-4o-mini")
    await model._client.aclose()

    def handler(request):
        body = json.loads(request.content)
        assert body["model"] == "gpt-4o-mini" and body["store"] is False
        assert body["messages"][-3:] == [
            {"role": "user", "content": "My name is Arjun."},
            {"role": "assistant", "content": "Hello, Arjun."},
            {"role": "user", "content": "What is my name?"},
        ]
        assert str(state.actor_id) not in json.dumps(body)
        schema = body["response_format"]["json_schema"]
        assert schema["strict"] and schema["schema"]["additionalProperties"] is False
        return httpx.Response(200, json={"choices": [{"message": {"content": decision.model_dump_json()}}]})

    model._client = httpx.AsyncClient(base_url="https://models.example/", transport=httpx.MockTransport(handler))
    assert await model.plan("What is my name?", state) == decision
    await model.aclose()
