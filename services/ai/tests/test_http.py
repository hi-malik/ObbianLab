from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from app.main import app
from app.models import AgentReply, Stage


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "demo")
    monkeypatch.setenv("AI_DEMO_TOKEN", "test-ai-token")
    class Pool:
        async def fetchrow(self, *args):
            return {"roles": ["customer"]}
    monkeypatch.setattr(app.state, "pool", Pool(), raising=False)
    return {
        "authorization": "Bearer test-ai-token",
        "x-tenant-id": str(uuid4()), "x-actor-id": str(uuid4()),
    }


@pytest.mark.asyncio
async def test_http_rejects_role_escalation(configured):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/rag/documents", headers={**configured, "x-roles": "knowledge_admin"},
                                     json={"external_key": "test", "title": "Test", "text": "Content"})
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_http_missing_auth_is_rejected(configured):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/agent/messages", json={"message": "electrician"})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_audio_unconfigured_is_explicit(configured, monkeypatch):
    monkeypatch.setattr(app.state, "transcriber", None, raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/agent/voice", headers=configured, files={"file": ("audio.wav", b"RIFF", "audio/wav")})
    assert response.status_code == 503
    assert "not configured" in response.json()["detail"]


@pytest.mark.asyncio
async def test_audio_obeys_same_workflow_and_identity(configured, monkeypatch):
    class Transcriber:
        async def transcribe(self, data, filename, content_type):
            assert data == b"RIFF"
            return "इलेक्ट्रीशियन"
    class Workflow:
        async def handle(self, actor, text, conversation_id):
            assert str(actor.actor_id) == configured["x-actor-id"]
            assert actor.roles == ["customer"]
            assert text == "इलेक्ट्रीशियन"
            return AgentReply(conversation_id=uuid4(), stage=Stage.COLLECTING, message="पता बताएं")
    monkeypatch.setattr(app.state, "transcriber", Transcriber(), raising=False)
    monkeypatch.setattr(app.state, "workflow", Workflow(), raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/agent/voice", headers=configured, files={"file": ("audio.wav", b"RIFF", "audio/wav")})
    assert response.status_code == 200
    assert response.json()["stage"] == "collecting"


@pytest.mark.asyncio
async def test_audio_unsupported_media_rejected(configured, monkeypatch):
    monkeypatch.setattr(app.state, "transcriber", object(), raising=False)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/agent/voice", headers=configured, files={"file": ("script.txt", b"code", "text/plain")})
    assert response.status_code == 415


@pytest.mark.asyncio
async def test_request_id_is_returned_without_echoing_unsafe_header(configured):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.get("/health/live", headers={"x-request-id": "review-test-123"})
    assert response.headers["x-request-id"] == "review-test-123"


@pytest.mark.asyncio
async def test_real_pdf_upload_is_extracted_in_subprocess(configured, monkeypatch):
    import io
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
    class Pool:
        async def fetchrow(self, *args):
            return {"roles": ["knowledge_admin"]}
    class Rag:
        async def ingest(self, actor, document):
            assert "Electrical isolation" in document.text
            return uuid4(), 1
    monkeypatch.setattr(app.state, "pool", Pool())
    monkeypatch.setattr(app.state, "rag", Rag(), raising=False)
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 10 20 Td (Electrical isolation) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    pdf = io.BytesIO()
    writer.write(pdf)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/rag/documents/pdf", headers=configured,
                                     data={"external_key": "test-pdf", "title": "Safety"},
                                     files={"file": ("safe.pdf", pdf.getvalue(), "application/pdf")})
    assert response.status_code == 200, response.text
    assert response.json()["version"] == 1


@pytest.mark.asyncio
async def test_oversized_http_body_rejected_before_parsing(configured):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        response = await client.post("/agent/messages", headers={**configured, "content-length": "30000000"}, content=b"{}")
    assert response.status_code == 413


@pytest.mark.asyncio
async def test_chunked_body_cannot_bypass_size_limit():
    from app.limits import BodyLimitMiddleware
    async def downstream(scope, receive, send):
        while (await receive()).get("more_body"):
            pass
    chunks = iter([{"type": "http.request", "body": b"123", "more_body": True}, {"type": "http.request", "body": b"456", "more_body": False}])
    async def receive(): return next(chunks)
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as error:
        await BodyLimitMiddleware(downstream, limit=5)({"type": "http", "headers": []}, receive, None)
    assert error.value.status_code == 413
