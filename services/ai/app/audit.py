from __future__ import annotations

import json
from typing import Any, Protocol
from uuid import UUID

import asyncpg

from .state import current_connection


class AuditSink(Protocol):
    async def write(
        self,
        tenant_id: UUID,
        conversation_id: UUID,
        actor_id: UUID,
        event_type: str,
        *,
        tool_name: str | None = None,
        request: dict[str, Any] | None = None,
        response: dict[str, Any] | None = None,
        decision: str | None = None,
    ) -> None: ...


class PostgresAuditSink:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    async def write(
        self,
        tenant_id: UUID,
        conversation_id: UUID,
        actor_id: UUID,
        event_type: str,
        *,
        tool_name: str | None = None,
        request: dict[str, Any] | None = None,
        response: dict[str, Any] | None = None,
        decision: str | None = None,
    ) -> None:
        await (current_connection.get() or self._pool).execute(
            """INSERT INTO ai_audit_events
               (tenant_id, conversation_id, actor_id, event_type, tool_name, request, response, decision)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)""",
            tenant_id, conversation_id, actor_id, event_type, tool_name,
            json.dumps(request) if request is not None else None,
            json.dumps(response) if response is not None else None,
            decision,
        )


class MemoryAuditSink:
    def __init__(self):
        self.events: list[dict[str, Any]] = []

    async def write(self, tenant_id, conversation_id, actor_id, event_type, **details) -> None:
        self.events.append({
            "tenant_id": tenant_id,
            "conversation_id": conversation_id,
            "actor_id": actor_id,
            "event_type": event_type,
            **details,
        })
