from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import math
import secrets
import time
from uuid import UUID

from fastapi import Header, HTTPException, Request

from .models import Identity
from .rate_limit import enforce_rate_limit


def signed_claims(token: str, secret: str) -> tuple[UUID, UUID]:
    if len(secret) < 32:
        raise ValueError("signing secret unavailable")
    header, body, signature = token.split(".")
    expected = base64.urlsafe_b64encode(hmac.digest(secret.encode(), f"{header}.{body}".encode(), hashlib.sha256)).rstrip(b"=").decode()
    if not secrets.compare_digest(signature, expected):
        raise ValueError("invalid signature")
    decode = lambda value: json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
    if decode(header).get("alg") != "HS256":
        raise ValueError("invalid algorithm")
    claims = decode(body)
    now = time.time()
    if claims.get("aud") != "obbian" or not isinstance(claims.get("exp"), (int, float)) or not math.isfinite(claims["exp"]) or claims["exp"] <= now:
        raise ValueError("invalid claims")
    if "nbf" in claims and (not isinstance(claims["nbf"], (int, float)) or not math.isfinite(claims["nbf"]) or claims["nbf"] > now):
        raise ValueError("token not yet valid")
    return UUID(claims["tenantId"]), UUID(claims["sub"])


async def identity(
    request: Request,
    authorization: str = Header(default=""),
    x_tenant_id: str = Header(default=""),
    x_actor_id: str = Header(default=""),
) -> Identity:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="bearer token required")
    token = authorization[7:]
    demo = os.getenv("AUTH_MODE") == "demo"
    service_token = os.getenv("AI_SERVICE_TOKEN") or (os.getenv("AI_DEMO_TOKEN", "local-ai-token") if demo else "")
    try:
        if service_token and secrets.compare_digest(token, service_token):
            tenant_id, actor_id = UUID(x_tenant_id), UUID(x_actor_id)
        else:
            tenant_id, actor_id = signed_claims(token, os.getenv("AUTH_SIGNING_SECRET", ""))
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise HTTPException(status_code=401, detail="invalid identity or bearer token") from error
    row = await request.app.state.pool.fetchrow(
        "SELECT roles FROM app_users WHERE id = $1 AND tenant_id = $2", actor_id, tenant_id,
    )
    if row is None:
        raise HTTPException(status_code=401, detail="unknown identity")
    if not demo:
        await enforce_rate_limit(request.app.state.redis, tenant_id, actor_id)
    return Identity(tenant_id=tenant_id, actor_id=actor_id, roles=row["roles"])
