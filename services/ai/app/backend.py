from __future__ import annotations

from typing import Protocol
from uuid import UUID

import httpx

from .models import BookingSlots, Identity


class BookingBackend(Protocol):
    async def category_id(self, identity: Identity, slug: str) -> UUID | None: ...
    async def availability(self, identity: Identity, slots: BookingSlots) -> bool: ...
    async def create_booking(self, identity: Identity, slots: BookingSlots, idempotency_key: str) -> UUID: ...


class HttpBookingBackend:
    def __init__(self, base_url: str, internal_token: str):
        self._client = httpx.AsyncClient(base_url=base_url, timeout=8)
        self._token = internal_token

    async def aclose(self):
        await self._client.aclose()

    def _headers(self, identity: Identity) -> dict[str, str]:
        return {
            "x-tenant-id": str(identity.tenant_id),
            "x-actor-id": str(identity.actor_id),
            "x-roles": ",".join(identity.roles),
            "authorization": f"Bearer {self._token}",
        }

    async def category_id(self, identity: Identity, slug: str) -> UUID | None:
        response = await self._client.get(f"/categories/{slug}", headers=self._headers(identity))
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return UUID(response.json()["id"])

    async def availability(self, identity: Identity, slots: BookingSlots) -> bool:
        response = await self._client.post(
            "/availability/check",
            headers=self._headers(identity),
            json={
                "categoryId": str(slots.category_id),
                "latitude": slots.latitude,
                "longitude": slots.longitude,
                "scheduledFor": slots.scheduled_for.isoformat(),
                "durationMinutes": slots.duration_minutes,
            },
        )
        response.raise_for_status()
        return bool(response.json()["available"])

    async def create_booking(self, identity: Identity, slots: BookingSlots, idempotency_key: str) -> UUID:
        response = await self._client.post(
            "/bookings",
            headers={**self._headers(identity), "idempotency-key": idempotency_key},
            json={
                "categoryId": str(slots.category_id),
                "latitude": slots.latitude,
                "longitude": slots.longitude,
                "address": slots.address,
                "scheduledFor": slots.scheduled_for.isoformat(),
                "durationMinutes": slots.duration_minutes,
            },
        )
        response.raise_for_status()
        return UUID(response.json()["id"])
