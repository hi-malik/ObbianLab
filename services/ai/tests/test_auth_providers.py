import base64
import hashlib
import hmac
import json
import time
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import HTTPException

from app.auth import identity, signed_claims
from app.models import IntentResult
from app.providers import HostedAnswerModel, HostedEmbeddings, HostedTranscriber, strict_schema


def token(claims, secret="s" * 32, algorithm="HS256"):
    encode = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b"=").decode()
    header, payload = encode({"alg": algorithm, "typ": "JWT"}), encode(claims)
    signature = base64.urlsafe_b64encode(hmac.digest(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256)).rstrip(b"=").decode()
    return f"{header}.{payload}.{signature}"


def claims():
    return {"sub": str(uuid4()), "tenantId": str(uuid4()), "aud": "obbian", "exp": time.time() + 60}


def test_signed_identity_is_bound_to_valid_claims():
    valid = claims()
    assert tuple(map(str, signed_claims(token(valid), "s" * 32))) == (valid["tenantId"], valid["sub"])
    for update in ({"exp": 0}, {"nbf": time.time() + 3600}, {"aud": "other"}):
        with pytest.raises(ValueError):
            signed_claims(token({**valid, **update}), "s" * 32)
    with pytest.raises(ValueError):
        signed_claims(token(valid), "x" * 32)
    with pytest.raises(ValueError):
        signed_claims(token(valid, algorithm="none"), "s" * 32)


@pytest.mark.asyncio
async def test_roles_are_always_loaded_from_database(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "demo")
    monkeypatch.setenv("AI_DEMO_TOKEN", "local-ai-token")
    class Pool:
        async def fetchrow(self, query, actor, tenant):
            return {"roles": ["customer"]}
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(pool=Pool())))
    actor = await identity(request, "Bearer local-ai-token", str(uuid4()), str(uuid4()))
    assert actor.roles == ["customer"]
    monkeypatch.setenv("AUTH_MODE", "production")
    monkeypatch.delenv("AI_SERVICE_TOKEN", raising=False)
    with pytest.raises(HTTPException) as error:
        await identity(request, "Bearer local-ai-token", str(uuid4()), str(uuid4()))
    assert error.value.status_code == 401


def test_llm_schema_is_strict_recursively():
    schema = strict_schema(IntentResult)
    def check(node):
        if isinstance(node, dict):
            assert "default" not in node
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
                assert set(node["required"]) == set(node["properties"])
            for value in node.values(): check(value)
        elif isinstance(node, list):
            for value in node: check(value)
    check(schema)


@pytest.mark.asyncio
async def test_embedding_adapter_enforces_dimensions_and_input_order():
    model = HostedEmbeddings("https://models.example", "secret", "embedding")
    async def handler(request):
        assert request.url.path == "/v1/embeddings"
        assert json.loads(request.content)["dimensions"] == 384
        return httpx.Response(200, json={"data": [{"index": 1, "embedding": [2.] * 384}, {"index": 0, "embedding": [1.] * 384}]})
    model._client = httpx.AsyncClient(base_url="https://models.example/", transport=httpx.MockTransport(handler))
    result = await model.embed(["a", "b"])
    assert result[0][0] == 1
    assert result[1][0] == 2
    await model.aclose()


@pytest.mark.asyncio
async def test_grounding_rejects_fabricated_citations():
    model = HostedAnswerModel("https://models.example", "secret", "llm")
    async def handler(request):
        payload = json.loads(request.content)
        assert "tools" not in payload
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({
            "abstain": False, "claims": [{"text": "Unsupported claim", "source": 1, "quote": "invented evidence"}]
        })}}]})
    model._client = httpx.AsyncClient(base_url="https://models.example/", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError, match="authorized evidence"):
        await model.answer("question", ["Actual authorized source content."])
    await model.aclose()


@pytest.mark.asyncio
async def test_audio_adapter_uploads_audio_and_returns_transcript():
    model = HostedTranscriber("https://models.example", "secret", "asr")
    async def handler(request):
        assert request.url.path == "/v1/audio/transcriptions"
        assert b"RIFF-audio" in request.content
        return httpx.Response(200, json={"text": "मुझे इलेक्ट्रीशियन चाहिए"})
    model._client = httpx.AsyncClient(base_url="https://models.example/", transport=httpx.MockTransport(handler))
    assert "इलेक्ट्रीशियन" in await model.transcribe(b"RIFF-audio", "speech.wav", "audio/wav")
    await model.aclose()
