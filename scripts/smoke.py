#!/usr/bin/env python3
"""End-to-end happy path. Uses only the Python standard library."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from uuid import uuid4

TENANT = "11111111-1111-4111-8111-111111111111"
CUSTOMER = "22222222-2222-4222-8222-222222222222"
PROFESSIONAL = "33333333-3333-4333-8333-333333333333"
FINANCE = "66666666-6666-4666-8666-666666666666"
KNOWLEDGE_ADMIN = "77777777-7777-4777-8777-777777777777"
PROFESSIONAL_RECORD = "44444444-4444-4444-8444-444444444444"
ELECTRICIAN = "55555555-5555-4555-8555-555555555551"


def request(method: str, url: str, body=None, headers=None):
    data = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {url} returned {error.code}: {error.read().decode()}") from error


def actor_headers(actor: str):
    return {"x-tenant-id": TENANT, "x-actor-id": actor}


def main():
    request("GET", "http://localhost:3001/health/ready")
    request("GET", "http://localhost:8000/health/ready")
    presence = request(
        "POST", "http://localhost:3001/professionals/me/presence",
        {"latitude": 28.6138, "longitude": 77.2090, "status": "available"},
        actor_headers(PROFESSIONAL),
    )
    assert presence["status"] == "available"
    # Vary the day so repeated demonstrations do not overlap an earlier confirmed
    # assignment left intentionally in the database.
    starts = (datetime.now(UTC) + timedelta(days=30 + uuid4().int % 300)).replace(microsecond=0)
    booking = request(
        "POST", "http://localhost:3001/bookings",
        {
            "categoryId": ELECTRICIAN,
            "latitude": 28.6139,
            "longitude": 77.2090,
            "address": "12 Lake Road, New Delhi",
            "scheduledFor": starts.isoformat(),
            "durationMinutes": 60,
        },
        {**actor_headers(CUSTOMER), "idempotency-key": f"smoke-booking-{uuid4()}"},
    )

    offer = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        offers = request("GET", "http://localhost:3001/professionals/me/offers", headers=actor_headers(PROFESSIONAL))
        offer = next((item for item in offers if item["bookingId"] == booking["id"]), None)
        if offer:
            break
        time.sleep(0.25)
    if not offer:
        raise RuntimeError("allocator did not produce an offer within 10 seconds")
    request("POST", f"http://localhost:3001/offers/{offer['id']}/accept", {}, actor_headers(PROFESSIONAL))
    tracked = request(
        "POST", f"http://localhost:3001/bookings/{booking['id']}/locations",
        {"latitude": 28.6140, "longitude": 77.2091, "recordedAt": datetime.now(UTC).isoformat()},
        actor_headers(PROFESSIONAL),
    )
    assert tracked["bookingId"] == booking["id"]

    payment = request(
        "POST", "http://localhost:3001/payments",
        {"bookingId": booking["id"], "amountMinor": 250000, "currency": "INR"},
        {**actor_headers(CUSTOMER), "idempotency-key": f"smoke-payment-{uuid4()}"},
    )
    webhook = {
        "eventId": f"evt_{uuid4().hex}",
        "type": "payment.captured",
        "gatewayPaymentId": payment["gatewayPaymentId"],
        "amountMinor": 250000,
    }
    raw = json.dumps(webhook, separators=(",", ":")).encode()
    signature = hmac.new(b"local-webhook-secret", raw, hashlib.sha256).hexdigest()
    first = request("POST", "http://localhost:3001/webhooks/sandbox", webhook, {"x-sandbox-signature": signature})
    second = request("POST", "http://localhost:3001/webhooks/sandbox", webhook, {"x-sandbox-signature": signature})
    assert first == {"accepted": True, "duplicate": False}
    assert second == {"accepted": True, "duplicate": True}
    stored_payment = request("GET", f"http://localhost:3001/payments/{payment['id']}", headers=actor_headers(CUSTOMER))
    assert stored_payment["status"] == "captured"

    refund = {
        "eventId": f"evt_{uuid4().hex}",
        "type": "payment.refunded",
        "gatewayPaymentId": payment["gatewayPaymentId"],
        "amountMinor": 50000,
    }
    refund_raw = json.dumps(refund, separators=(",", ":")).encode()
    refund_signature = hmac.new(b"local-webhook-secret", refund_raw, hashlib.sha256).hexdigest()
    refund_first = request(
        "POST", "http://localhost:3001/webhooks/sandbox", refund,
        {"x-sandbox-signature": refund_signature},
    )
    refund_second = request(
        "POST", "http://localhost:3001/webhooks/sandbox", refund,
        {"x-sandbox-signature": refund_signature},
    )
    assert refund_first == {"accepted": True, "duplicate": False}
    assert refund_second == {"accepted": True, "duplicate": True}
    stored_payment = request("GET", f"http://localhost:3001/payments/{payment['id']}", headers=actor_headers(CUSTOMER))
    assert stored_payment["status"] == "partially_refunded" and int(stored_payment["refundedMinor"]) == 50000
    reconciliation = request(
        "GET", "http://localhost:3001/payments/reconciliation/report",
        headers={**actor_headers(FINANCE)},
    )
    assert reconciliation["mismatchCount"] == 0 and reconciliation["checkedPayments"] > 0

    settlement_key = f"smoke-settlement-{uuid4()}"
    settlement_body = {
        "professionalId": PROFESSIONAL_RECORD,
        "currency": "INR",
        "periodStart": (datetime.now(UTC) - timedelta(days=365)).isoformat(),
        "periodEnd": (datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    }
    settlement_headers = {
        **actor_headers(FINANCE), "idempotency-key": settlement_key,
    }
    settlement = request(
        "POST", "http://localhost:3001/settlements",
        settlement_body,
        settlement_headers,
    )
    assert settlement["status"] == "paid" and int(settlement["amountMinor"]) > 0
    settlement_replay = request(
        "POST", "http://localhost:3001/settlements", settlement_body, settlement_headers,
    )
    assert settlement_replay == settlement

    ai_headers = {
        **actor_headers(CUSTOMER),
        "authorization": "Bearer local-ai-token",
        "x-roles": "customer",
    }
    ai_starts = (starts + timedelta(days=1)).isoformat()
    proposal = request(
        "POST", "http://localhost:8000/agent/messages",
        {"message": f"electrician at: 12 Lake Road; 28.6139,77.2090 on {ai_starts}"}, ai_headers,
    )
    assert proposal["stage"] == "awaiting_confirmation"
    confirmed = request(
        "POST", "http://localhost:8000/agent/messages",
        {"conversation_id": proposal["conversation_id"], "message": "confirm"}, ai_headers,
    )
    assert confirmed["stage"] == "completed"
    cancelled = request(
        "POST", f"http://localhost:3001/bookings/{confirmed['booking_id']}/cancel", {}, actor_headers(CUSTOMER),
    )
    assert cancelled["status"] == "cancelled"

    document = request(
        "POST", "http://localhost:8000/rag/documents",
        {
            "external_key": "breaker-safety",
            "title": "Circuit breaker field guide",
            "text": "Switch off the main supply before inspecting a distribution board. A repeatedly tripping breaker requires a qualified electrician. Never bypass the breaker.",
            "allowed_roles": ["customer"],
        },
        {**ai_headers, **actor_headers(KNOWLEDGE_ADMIN)},
    )
    updated_document = request(
        "POST", "http://localhost:8000/rag/documents",
        {
            "external_key": "breaker-safety",
            "title": "Circuit breaker field guide",
            "text": "Switch off and isolate the main supply before inspecting a distribution board. A repeatedly tripping breaker requires a qualified electrician. Never bypass the breaker.",
            "allowed_roles": ["customer"],
        },
        {**ai_headers, **actor_headers(KNOWLEDGE_ADMIN)},
    )
    assert updated_document["id"] == document["id"] and updated_document["version"] == document["version"] + 1
    document = updated_document
    answer = request(
        "POST", "http://localhost:8000/rag/query",
        {"question": "What should I do before inspecting a distribution board?"}, ai_headers,
    )
    assert answer["grounded"] and answer["citations"][0]["document_id"] == document["id"]

    lifecycle_key = f"delete-check-{uuid4().hex}"
    lifecycle_role = "knowledge_admin"
    lifecycle = request(
        "POST", "http://localhost:8000/rag/documents",
        {
            "external_key": lifecycle_key,
            "title": "Temporary deletion check",
            "text": "The Zyphor isolation procedure requires the amber lever before maintenance.",
            "allowed_roles": [lifecycle_role],
        },
        {**ai_headers, **actor_headers(KNOWLEDGE_ADMIN)},
    )
    lifecycle_headers = {**ai_headers, **actor_headers(KNOWLEDGE_ADMIN)}
    before_delete = request(
        "POST", "http://localhost:8000/rag/query",
        {"question": "What does the Zyphor isolation procedure require?"}, lifecycle_headers,
    )
    assert before_delete["grounded"] and before_delete["citations"][0]["document_id"] == lifecycle["id"]
    deleted = request(
        "DELETE", f"http://localhost:8000/rag/documents/{lifecycle_key}",
        headers={**ai_headers, **actor_headers(KNOWLEDGE_ADMIN)},
    )
    assert deleted["deleted"] is True
    after_delete = request(
        "POST", "http://localhost:8000/rag/query",
        {"question": "What does the Zyphor isolation procedure require?"}, lifecycle_headers,
    )
    assert after_delete["grounded"] is False and after_delete["citations"] == []

    print(json.dumps({
        "booking": booking["id"],
        "offer": offer["id"],
        "payment": payment["id"],
        "settlement": settlement["id"],
        "ai_booking": confirmed["booking_id"],
        "rag_document": document["id"],
        "status": "passed",
    }, indent=2))


if __name__ == "__main__":
    main()
