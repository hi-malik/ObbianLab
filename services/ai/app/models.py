from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, field_validator


class Stage(StrEnum):
    COLLECTING = "collecting"
    AWAITING_CONFIRMATION = "awaiting_confirmation"
    EXECUTING = "executing"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    FAILED = "failed"


class BookingSlots(BaseModel):
    category: str | None = Field(default=None, max_length=100)
    category_id: UUID | None = None
    address: str | None = Field(default=None, max_length=1000)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    scheduled_for: datetime | None = None
    duration_minutes: int = Field(default=60, ge=5, le=480)

    @field_validator("scheduled_for")
    @classmethod
    def timezone_required(cls, value):
        if value is not None and value.tzinfo is None:
            raise ValueError("scheduled_for must include a timezone")
        return value

    def missing(self) -> list[str]:
        required = ("category", "address", "latitude", "longitude", "scheduled_for")
        return [name for name in required if getattr(self, name) is None]


class IntentResult(BaseModel):
    intent: Literal["book_service", "cancel", "unknown"]
    language: Literal["en", "hi"] = "en"
    slots: BookingSlots = Field(default_factory=BookingSlots)
    explicit_confirmation: bool = False
    confidence: float = Field(ge=0, le=1)


class ConversationState(BaseModel):
    conversation_id: UUID = Field(default_factory=uuid4)
    tenant_id: UUID
    actor_id: UUID
    stage: Stage = Stage.COLLECTING
    slots: BookingSlots = Field(default_factory=BookingSlots)
    proposed_at: datetime | None = None
    booking_id: UUID | None = None
    last_error: str | None = None


class AgentMessage(BaseModel):
    conversation_id: UUID | None = None
    message: str = Field(min_length=1, max_length=4000)


class AgentReply(BaseModel):
    conversation_id: UUID
    stage: Stage
    message: str
    booking_id: UUID | None = None
    required_fields: list[str] = Field(default_factory=list)


class Identity(BaseModel):
    tenant_id: UUID
    actor_id: UUID
    roles: list[str] = Field(default_factory=list)
