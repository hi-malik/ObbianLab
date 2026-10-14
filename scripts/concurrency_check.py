#!/usr/bin/env python3
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import uuid4

TENANT = "11111111-1111-4111-8111-111111111111"
CUSTOMER = "22222222-2222-4222-8222-222222222222"
PROFESSIONAL = "33333333-3333-4333-8333-333333333333"
CATEGORY = "55555555-5555-4555-8555-555555555551"


def call(method, path, actor, body=None, extra=None):
    data = json.dumps(body or {}, separators=(",", ":")).encode() if method == "POST" else None
    request = urllib.request.Request(
        f"http://localhost:3001{path}", method=method, data=data,
        headers={"content-type": "application/json", "x-tenant-id": TENANT, "x-actor-id": actor, **(extra or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def main():
    status, presence = call("POST", "/professionals/me/presence", PROFESSIONAL, {
        "latitude": 28.6138, "longitude": 77.2090, "status": "available",
    })
    assert status == 201 and presence["status"] == "available", presence
    # Use a different future window on repeated local runs; the confirmed winner
    # is intentionally retained so the database exclusion constraint remains visible.
    scheduled = (datetime.now(UTC) + timedelta(days=30 + uuid4().int % 300)).replace(microsecond=0).isoformat()
    bookings = []
    for number in range(2):
        status, booking = call("POST", "/bookings", CUSTOMER, {
            "categoryId": CATEGORY, "latitude": 28.6139, "longitude": 77.2090,
            "address": f"Concurrency test {number}", "scheduledFor": scheduled, "durationMinutes": 60,
        }, {"idempotency-key": f"concurrency-{uuid4()}"})
        assert status == 201, booking
        bookings.append(booking["id"])

    offers = {}
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and len(offers) != 2:
        status, pending = call("GET", "/professionals/me/offers", PROFESSIONAL)
        assert status == 200
        for offer in pending:
            if offer["bookingId"] in bookings:
                offers[offer["bookingId"]] = offer["id"]
        time.sleep(.15)
    if len(offers) != 2:
        raise RuntimeError(f"expected two competing offers, found {len(offers)}")

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(
            lambda offer_id: call("POST", f"/offers/{offer_id}/accept", PROFESSIONAL, {}),
            offers.values(),
        ))
    codes = sorted(code for code, _ in responses)
    assert codes == [201, 409], responses
    states = [call("GET", f"/bookings/{booking_id}", CUSTOMER)[1]["status"] for booking_id in bookings]
    assert states.count("confirmed") == 1, states
    print(json.dumps({"status": "passed", "http_statuses": codes, "booking_states": states}, indent=2))


if __name__ == "__main__":
    main()
