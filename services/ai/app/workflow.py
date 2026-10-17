from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import httpx

from .audit import AuditSink
from .backend import BookingBackend
from .intent import CANCELLATIONS, IntentModel, is_explicit_confirmation
from .models import AgentReply, BookingSlots, ChatTurn, ConversationState, Identity, IntentResult, Stage


from .state import MemoryStateStore, PostgresStateStore


QUESTIONS = {
    "en": {
        "category": "What service do you need: an electrician, plumber, cleaner, or ride?",
        "address": "What address should the professional come to?",
        "latitude": "Please share the location as latitude, longitude.",
        "longitude": "Please share the location as latitude, longitude.",
        "scheduled_for": "When should the service start? Please include the timezone.",
    },
    "hi": {
        "category": "आपको कौन-सी सेवा चाहिए: इलेक्ट्रीशियन, प्लंबर, सफाई या ऑटो?",
        "address": "प्रोफेशनल को किस पते पर आना है?",
        "latitude": "कृपया लोकेशन latitude, longitude में भेजें।",
        "longitude": "कृपया लोकेशन latitude, longitude में भेजें।",
        "scheduled_for": "सेवा कब शुरू होनी चाहिए? समय क्षेत्र भी बताएं।",
    },
}


class BookingWorkflow:
    def __init__(self, model: IntentModel, backend: BookingBackend, audit: AuditSink, states: Any, chat_model=None):
        self._model = model
        self._backend = backend
        self._audit = audit
        self._states = states
        self._chat_model = chat_model

    async def handle(self, identity: Identity, text: str, conversation_id: UUID | None = None) -> AgentReply:
        key = conversation_id or uuid4()
        async with self._states.lock(key):
            state = await self._states.get(key)
            if state is None:
                if conversation_id is not None:
                    raise PermissionError("conversation does not exist")
                state = ConversationState(conversation_id=key, tenant_id=identity.tenant_id, actor_id=identity.actor_id)
                await self._states.put(state)
            if state.tenant_id != identity.tenant_id or state.actor_id != identity.actor_id:
                raise PermissionError("conversation does not belong to this identity")
            if self._chat_model:
                return await self._handle_chat_locked(identity, text, state)
            return await self._handle_locked(identity, text, state)

    def _reply(self, state, message, **kwargs):
        return AgentReply(conversation_id=state.conversation_id, stage=state.stage,
                          booking_id=state.booking_id, message=message, **kwargs)

    async def _handle_chat_locked(self, identity, text, state):
        normalized = " ".join(text.strip().split()).casefold()
        has_draft = any(value is not None for field, value in state.slots.model_dump().items() if field != "duration_minutes")
        # Confirm/recovery actions bypass the model, including retries after a lost response.
        critical = state.stage in (Stage.EXECUTING, Stage.FAILED) or (
            (is_explicit_confirmation(text) or normalized in CANCELLATIONS)
            and (state.stage != Stage.COLLECTING or has_draft)
        )
        intent = None
        if not critical:
            try:
                decision = await self._chat_model.plan(text, state)
            except Exception as error:
                await self._audit.write(identity.tenant_id, state.conversation_id, identity.actor_id,
                                        "chat.failed", response={"error_type": type(error).__name__})
                reply = self._reply(state, "Zara AI could not reach the AI service reliably. Please try your message again. No booking action was taken.")
                return await self._remember(state, text, reply)
            state.preferred_language = decision.preferred_language
            if decision.route == "chat":
                # General questions must not modify booking slots or trigger backend tools.
                return await self._remember(state, text, self._reply(state, decision.reply))
            intent = IntentResult(intent="book_service", confidence=1,
                                  language="hi" if state.preferred_language == "hi" else "en",
                                  slots=decision.slots)

        reply = await self._handle_locked(identity, text, state, intent)
        if not reply.required_fields:
            # This receipt is deterministic and remains visible even if generation fails.
            reply.booking_update = reply.message
        try:
            reply.message = await self._chat_model.respond(text, state, reply)
        except Exception:
            pass  # Preserve the committed result; prose generation cannot undo a booking.
        return await self._remember(state, text, reply)

    async def _remember(self, state, text, reply):
        answer = reply.message + ("\nVerified booking update: " + reply.booking_update if reply.booking_update else "")
        history = [*state.history, ChatTurn(role="user", content=text),
                   ChatTurn(role="assistant", content=answer[:8000])][-20:]
        while len(history) > 2 and sum(len(turn.content) for turn in history) > 24000:
            history = history[2:]
        state.history = history
        await self._states.put(state)
        return reply

    async def _handle_locked(self, identity: Identity, text: str, state: ConversationState, intent: IntentResult | None = None) -> AgentReply:
        if state.stage in (Stage.COMPLETED, Stage.CANCELLED):
            return self._reply(state, "This request is already closed. Use New chat to start another booking.")

        # This path runs before model extraction: models cannot approve actions,
        # change an already submitted payload, or turn an uncertain commit into a cancellation.
        if state.stage in (Stage.EXECUTING, Stage.FAILED):
            if is_explicit_confirmation(text) or text.strip().casefold() == "retry":
                return await self._execute(identity, state)
            return self._reply(state, "The previous booking outcome is uncertain. Reply ‘retry’ to recover the same request safely. Do not start another booking until its outcome is known.")

        if " ".join(text.strip().split()).casefold() in CANCELLATIONS:
            state.stage = Stage.CANCELLED
            await self._states.put(state)
            await self._audit.write(identity.tenant_id, state.conversation_id, identity.actor_id,
                                    "workflow.cancelled", decision="user_cancelled")
            return self._reply(state, "Okay, I did not create a booking.")

        if state.stage == Stage.AWAITING_CONFIRMATION and is_explicit_confirmation(text):
            if not state.proposed_at or (datetime.now(UTC) - state.proposed_at).total_seconds() > 300:
                state.stage = Stage.COLLECTING
                await self._states.put(state)
                return self._reply(state, "The proposal expired. Send the request again to check availability before confirming.")
            try:
                available = await self._backend.availability(identity, state.slots)
            except Exception:
                return self._reply(state, "Availability could not be checked. No booking was submitted. Please try confirming again.")
            if not available:
                state.stage = Stage.COLLECTING
                await self._states.put(state)
                return self._reply(state, "Availability changed. No booking was submitted. Please choose another time or place.")
            await self._audit.write(identity.tenant_id, state.conversation_id, identity.actor_id,
                                    "workflow.confirmed", request=state.slots.model_dump(mode="json"),
                                    decision="explicitly_confirmed")
            return await self._execute(identity, state)

        try:
            if intent is None:
                intent = await self._model.extract(text)
        except Exception as error:
            await self._audit.write(identity.tenant_id, state.conversation_id, identity.actor_id,
                                    "intent.failed", response={"error_type": type(error).__name__})
            return self._reply(state, "I could not read that request reliably. Please include a service, address, coordinates, and a date with timezone.")
        await self._audit.write(
            identity.tenant_id, state.conversation_id, identity.actor_id, "intent.extracted",
            request={"text": text}, response=intent.model_dump(mode="json"),
        )
        # category IDs are always resolved from the backend, never model-selected.
        intent.slots.category_id = None
        updated = merge_slots(state.slots, intent.slots)
        if state.stage == Stage.AWAITING_CONFIRMATION:
            if updated == state.slots:
                return self._reply(state, "No booking was created. Reply ‘confirm’ to approve this exact request, or ‘cancel’.")
            state.stage = Stage.COLLECTING
            state.proposed_at = None
        state.slots = updated
        missing = state.slots.missing()
        if state.slots.scheduled_for and state.slots.scheduled_for <= datetime.now(UTC):
            state.slots.scheduled_for = None
            missing = state.slots.missing()
        if missing:
            await self._states.put(state)
            return self._reply(state, QUESTIONS[intent.language][missing[0]], required_fields=missing)

        try:
            category_id = await self._backend.category_id(identity, state.slots.category or "")
            await self._audit.write(
                identity.tenant_id, state.conversation_id, identity.actor_id, "tool.called",
                tool_name="resolve_category", request={"slug": state.slots.category},
                response={"category_id": str(category_id) if category_id else None},
            )
            if not category_id:
                state.slots.category = None
                await self._states.put(state)
                return self._reply(state, "That service is not available in this tenant.", required_fields=["category"])
            state.slots.category_id = category_id
            available = await self._backend.availability(identity, state.slots)
            await self._audit.write(
                identity.tenant_id, state.conversation_id, identity.actor_id, "tool.called",
                tool_name="check_availability", request=state.slots.model_dump(mode="json"),
                response={"available": available},
            )
        except Exception as error:
            await self._states.put(state)
            await self._audit.write(identity.tenant_id, state.conversation_id, identity.actor_id,
                                    "tool.failed", response={"error_type": type(error).__name__})
            return self._reply(state, "The availability service is temporarily unavailable. No booking was submitted. Please retry.")
        if not available:
            await self._states.put(state)
            return self._reply(state, "No eligible professional is currently available for that place and time. The booking was not created.")

        state.stage = Stage.AWAITING_CONFIRMATION
        state.proposed_at = datetime.now(UTC)
        await self._states.put(state)
        summary = (f"{state.slots.category} at {state.slots.address} "
                   f"({state.slots.latitude}, {state.slots.longitude}) on "
                   f"{state.slots.scheduled_for.isoformat()} for {state.slots.duration_minutes} minutes")
        return self._reply(state, f"I found availability for {summary}. Reply ‘confirm’ to create the booking, or ‘cancel’.")

    async def _execute(self, identity: Identity, state: ConversationState) -> AgentReply:
        state.stage = Stage.EXECUTING
        await self._states.put(state)
        try:
            booking_id = await self._backend.create_booking(
                identity, state.slots, idempotency_key=f"ai:{state.conversation_id}"
            )
        except Exception as error:
            definitive = isinstance(error, httpx.HTTPStatusError) and error.response.status_code in (400, 401, 403, 404, 422)
            state.stage = Stage.COLLECTING if definitive else Stage.FAILED
            state.last_error = type(error).__name__
            await self._states.put(state)
            await self._audit.write(
                identity.tenant_id, state.conversation_id, identity.actor_id, "tool.failed",
                tool_name="create_booking", response={"error_type": type(error).__name__},
                decision="backend_rejected" if definitive else "outcome_uncertain",
            )
            return self._reply(state,
                "The backend rejected the request. No booking was created. Please correct the details and try again."
                if definitive else "The booking outcome is uncertain. Reply ‘retry’ to recover the same request safely; it will not create a duplicate.")
        # Persist success before audit output: an audit failure must never relabel a
        # known successful booking as failed or cause a second booking to be made.
        state.booking_id = booking_id
        state.stage = Stage.COMPLETED
        state.last_error = None
        await self._states.put(state)
        await self._audit.write(
            identity.tenant_id, state.conversation_id, identity.actor_id, "tool.called",
            tool_name="create_booking", request=state.slots.model_dump(mode="json"),
            response={"booking_id": str(booking_id)}, decision="explicitly_confirmed",
        )
        return self._reply(state, f"Booking request accepted by the backend. Professional assignment is pending. Reference: {booking_id}")


def merge_slots(current: BookingSlots, update: BookingSlots) -> BookingSlots:
    merged = current.model_dump()
    for field, value in update.model_dump().items():
        if value is not None and (field != "duration_minutes" or value != 60 or current.duration_minutes == 60):
            merged[field] = value
    return BookingSlots.model_validate(merged)
