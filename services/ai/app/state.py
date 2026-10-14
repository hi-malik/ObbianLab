from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from uuid import UUID

import asyncpg

from .models import ConversationState

# Reuse the lock-owning connection for state and audit writes. This avoids a pool
# deadlock when multiple replicas wait on the same conversation.
current_connection: ContextVar[asyncpg.Connection | None] = ContextVar("ai_connection", default=None)


class MemoryStateStore:
    def __init__(self):
        self._states: dict[UUID, ConversationState] = {}
        self._locks: dict[UUID, asyncio.Lock] = {}

    @asynccontextmanager
    async def lock(self, conversation_id: UUID):
        async with self._locks.setdefault(conversation_id, asyncio.Lock()):
            yield

    async def get(self, conversation_id: UUID) -> ConversationState | None:
        state = self._states.get(conversation_id)
        return state.model_copy(deep=True) if state else None

    async def put(self, state: ConversationState) -> None:
        self._states[state.conversation_id] = state.model_copy(deep=True)


class PostgresStateStore:
    """Durable state with a session advisory lock spanning the tool call.

    Each state/audit write commits before an external side effect; a process crash
    releases the lock and leaves EXECUTING for an idempotent retry. No Redis TTL
    or cache eviction can erase the booking's confirmation/idempotency identity.
    """

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    @asynccontextmanager
    async def lock(self, conversation_id: UUID):
        key = conversation_id.int & ((1 << 63) - 1)
        async with self._pool.acquire() as connection:
            await connection.execute("SELECT pg_advisory_lock($1)", key)
            token = current_connection.set(connection)
            try:
                yield
            finally:
                current_connection.reset(token)
                await connection.execute("SELECT pg_advisory_unlock($1)", key)

    async def get(self, conversation_id: UUID) -> ConversationState | None:
        connection = current_connection.get() or self._pool
        value = await connection.fetchval("SELECT state FROM ai_conversations WHERE id = $1", conversation_id)
        return ConversationState.model_validate_json(value) if value else None

    async def put(self, state: ConversationState) -> None:
        connection = current_connection.get() or self._pool
        await connection.execute(
            """INSERT INTO ai_conversations (id, tenant_id, actor_id, state)
               VALUES ($1, $2, $3, $4::jsonb)
               ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
               WHERE ai_conversations.tenant_id = EXCLUDED.tenant_id
                 AND ai_conversations.actor_id = EXCLUDED.actor_id""",
            state.conversation_id, state.tenant_id, state.actor_id, state.model_dump_json(),
        )
