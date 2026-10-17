from __future__ import annotations

import os
import asyncio
import sys
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

import asyncpg
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
import httpx
from redis.asyncio import Redis

from .audit import PostgresAuditSink
from .auth import identity
from .limits import BodyLimitMiddleware
from .providers import HostedAnswerModel, HostedEmbeddings, HostedTranscriber
from .backend import HttpBookingBackend
from .chat import HostedChatModel
from .intent import DeterministicIntentModel, StructuredLlmIntentModel
from .models import AgentMessage, AgentReply, Identity
from .rag import DocumentInput, QueryAnswer, QueryInput, RagService
from .workflow import BookingWorkflow
from .state import PostgresStateStore


@asynccontextmanager
async def lifespan(app: FastAPI):
    database_url = os.getenv("DATABASE_URL", "postgres://obbian:obbian@localhost:5432/obbian")
    pool = await asyncpg.create_pool(database_url, min_size=1, max_size=10, command_timeout=10)
    redis = Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"), decode_responses=True)
    app.state.pool = pool
    app.state.redis = redis
    demo = os.getenv("AUTH_MODE") == "demo"
    llm_key = os.getenv("LLM_API_KEY")
    embedding_key = os.getenv("EMBEDDING_API_KEY", llm_key or "")
    offline = os.getenv("AI_PROVIDER_MODE") == "offline"
    if not demo:
        required = [name for name in ("AI_SERVICE_TOKEN", "INTERNAL_SERVICE_TOKEN") if len(os.getenv(name, "")) < 32]
        if required or (not offline and (not llm_key or not embedding_key)):
            await redis.aclose()
            await pool.close()
            raise RuntimeError("Strict authentication requires strong service tokens; hosted mode also requires LLM and embedding credentials")
    if offline:
        llm_key, embedding_key = None, ""
    llm_base = os.getenv("LLM_BASE_URL", "https://api.openai.com")
    llm_model = os.getenv("LLM_MODEL", "gpt-4o-mini")
    intent_model = StructuredLlmIntentModel(llm_base, llm_key, llm_model) if llm_key else DeterministicIntentModel()
    chat_model = HostedChatModel(llm_base, llm_key, llm_model) if llm_key else None
    backend = HttpBookingBackend(os.getenv("BOOKING_API_URL", "http://localhost:3001"),
                                 os.getenv("INTERNAL_SERVICE_TOKEN", "local-internal-token"))
    embeddings = HostedEmbeddings(os.getenv("EMBEDDING_BASE_URL", llm_base), embedding_key,
                                  os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")) if embedding_key else None
    answer_model = HostedAnswerModel(llm_base, llm_key, llm_model) if llm_key else None
    asr_key = "" if offline else os.getenv("ASR_API_KEY", llm_key or "")
    transcriber = HostedTranscriber(os.getenv("ASR_BASE_URL", llm_base), asr_key,
                                   os.getenv("ASR_MODEL", "whisper-1")) if asr_key else None
    app.state.workflow = BookingWorkflow(intent_model, backend, PostgresAuditSink(pool), PostgresStateStore(pool), chat_model)
    app.state.rag = RagService(pool, embeddings, answer_model)
    app.state.transcriber = transcriber
    try:
        yield
    finally:
        for component in (backend, intent_model, chat_model, embeddings, answer_model, transcriber):
            if component and hasattr(component, "aclose"):
                await component.aclose()
        await redis.aclose()
        await pool.close()


app = FastAPI(title="Obbian AI and knowledge service", version="1.0.0", lifespan=lifespan)
app.add_middleware(BodyLimitMiddleware)


@app.middleware("http")
async def request_logging(request: Request, call_next):
    supplied = request.headers.get("x-request-id", "")
    request_id = supplied if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", supplied) else str(uuid4())
    started, status = time.perf_counter(), 500
    try:
        response = await call_next(request)
        status = response.status_code
        response.headers["x-request-id"] = request_id
        return response
    finally:
        route = request.scope.get("route")
        logging.getLogger("uvicorn.error").info(json.dumps({
            "event": "http.request", "requestId": request_id,
            "method": request.method, "route": getattr(route, "path", "<unmatched>"),
            "status": status, "durationMs": round((time.perf_counter() - started) * 1000, 3),
        }))


@app.exception_handler(httpx.HTTPError)
async def provider_unavailable(request, error):
    return JSONResponse(status_code=503, content={"detail": "Upstream service is unavailable. Please retry."})


@app.exception_handler(ValueError)
async def invalid_model_output(request, error):
    return JSONResponse(status_code=422, content={"detail": "The supplied content or model response could not be validated."})


@app.get("/health/live")
async def live():
    return {"status": "ok"}


@app.get("/health/ready")
async def ready(request: Request):
    await request.app.state.pool.fetchval("SELECT 1")
    await request.app.state.redis.ping()
    return {"status": "ready"}


@app.post("/agent/messages", response_model=AgentReply)
async def message(body: AgentMessage, request: Request, actor: Identity = Depends(identity)):
    try:
        return await request.app.state.workflow.handle(actor, body.message, body.conversation_id)
    except PermissionError as error:
        raise HTTPException(status_code=404, detail="conversation not found") from error


@app.post("/agent/voice-transcripts", response_model=AgentReply)
async def voice_transcript(body: AgentMessage, request: Request, actor: Identity = Depends(identity)):
    """Accepts a trusted ASR transcript; audio decoding is outside this service boundary."""
    return await message(body, request, actor)


@app.post("/agent/voice", response_model=AgentReply)
async def voice(
    request: Request,
    file: UploadFile = File(),
    conversation_id: UUID | None = Form(default=None),
    actor: Identity = Depends(identity),
):
    """Transcribe uploaded speech then apply the same authorization and confirmation policy."""
    transcriber = request.app.state.transcriber
    if transcriber is None:
        raise HTTPException(status_code=503, detail="Audio transcription is not configured. Use text or a trusted transcript.")
    allowed = {"audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a",
               "audio/webm": "webm", "video/webm": "webm", "audio/ogg": "ogg"}
    if file.content_type not in allowed:
        raise HTTPException(status_code=415, detail="Supported audio: WAV, MP3, M4A, WebM, Ogg")
    data = await file.read(10_000_001)
    if not data or len(data) > 10_000_000:
        raise HTTPException(status_code=413, detail="Audio must contain 1 byte to 10 MB")
    transcript = await transcriber.transcribe(data, "speech." + allowed[file.content_type], file.content_type)
    return await message(AgentMessage(message=transcript, conversation_id=conversation_id), request, actor)


@app.post("/rag/documents")
async def ingest_document(body: DocumentInput, request: Request, actor: Identity = Depends(identity)):
    if "knowledge_admin" not in actor.roles:
        raise HTTPException(status_code=403, detail="knowledge_admin role required")
    document_id, version = await request.app.state.rag.ingest(actor, body)
    return {"id": document_id, "version": version}


@app.post("/rag/documents/pdf")
async def ingest_pdf(
    request: Request,
    external_key: str = Form(),
    title: str = Form(),
    allowed_roles: str = Form(default=""),
    file: UploadFile = File(),
    actor: Identity = Depends(identity),
):
    if "knowledge_admin" not in actor.roles:
        raise HTTPException(status_code=403, detail="knowledge_admin role required")
    if file.content_type != "application/pdf":
        raise HTTPException(status_code=415, detail="only PDF files are accepted")
    data = await file.read(20_000_001)
    if len(data) > 20_000_000:
        raise HTTPException(status_code=413, detail="PDF exceeds 20 MB")
    try:
        parser = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "app.pdf_worker", stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            output, _ = await asyncio.wait_for(parser.communicate(data), timeout=15)
        except BaseException:
            if parser.returncode is None:
                parser.kill()
                await parser.wait()
            raise
        if parser.returncode:
            raise ValueError("PDF parser rejected the file")
        text = output.decode("utf-8")
    except Exception as error:
        raise HTTPException(status_code=422, detail="PDF text extraction failed") from error
    if not text:
        raise HTTPException(status_code=422, detail="PDF contains no extractable text")
    document = DocumentInput(
        external_key=external_key, title=title, text=text,
        allowed_roles=[role for role in allowed_roles.split(",") if role],
    )
    document_id, version = await request.app.state.rag.ingest(actor, document)
    return {"id": document_id, "version": version}


@app.delete("/rag/documents/{external_key}")
async def delete_document(external_key: str, request: Request, actor: Identity = Depends(identity)):
    if "knowledge_admin" not in actor.roles:
        raise HTTPException(status_code=403, detail="knowledge_admin role required")
    return {"deleted": await request.app.state.rag.delete(actor, external_key)}


@app.post("/rag/query", response_model=QueryAnswer)
async def query(body: QueryInput, request: Request, actor: Identity = Depends(identity)):
    return await request.app.state.rag.query(actor, body)
