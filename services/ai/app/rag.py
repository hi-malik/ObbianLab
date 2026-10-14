from __future__ import annotations

import hashlib
import io
import math
import re
from dataclasses import dataclass
from typing import Iterable
from uuid import UUID

import asyncpg
from pydantic import BaseModel, Field, field_validator
from pypdf import PdfReader

from .models import Identity
from .providers import HostedAnswerModel


class DocumentInput(BaseModel):
    external_key: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=500)
    text: str = Field(min_length=1, max_length=2_000_000)
    classification: str = Field(default="internal", max_length=50)
    allowed_roles: list[str] = Field(default_factory=list)
    allowed_users: list[UUID] = Field(default_factory=list, max_length=100)

    @field_validator("text")
    @classmethod
    def nonblank_text(cls, value):
        if not value.strip():
            raise ValueError("document must contain text")
        return value

    @field_validator("allowed_roles")
    @classmethod
    def normalize_roles(cls, value):
        normalized = sorted(set(role.strip() for role in value if role.strip()))
        if len(normalized) > 100 or any(len(role) > 100 for role in normalized):
            raise ValueError("too many roles or invalid role length")
        return normalized


class QueryInput(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    limit: int = Field(default=5, ge=1, le=10)


class Citation(BaseModel):
    document_id: UUID
    title: str
    chunk: int
    excerpt: str
    version: int = 1


class QueryAnswer(BaseModel):
    answer: str
    citations: list[Citation]
    grounded: bool
    mode: str = "extractive-demo"


def chunk_text(text: str, size: int = 140, overlap: int = 25) -> list[str]:
    if size < 1 or overlap < 0 or overlap >= size:
        raise ValueError("overlap must be smaller than chunk size")
    words = text.split()
    chunks: list[str] = []
    start = 0
    while start < len(words):
        chunks.append(" ".join(words[start:start + size]))
        if start + size >= len(words):
            break
        start += size - overlap
    return chunks


def embedding(text: str, dimensions: int = 384) -> list[float]:
    values = [0.0] * dimensions
    tokens = re.findall(r"[\w-]+", text.casefold())
    for token in tokens:
        digest = hashlib.sha256(token.encode()).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        values[index] += -1.0 if digest[4] & 1 else 1.0
    norm = math.sqrt(sum(value * value for value in values)) or 1.0
    return [value / norm for value in values]


def strip_instructions(text: str) -> str:
    unsafe = re.compile(
        r"(?i)(ignore (all )?(previous|system).{0,120}|reveal (the )?(system )?prompt.{0,120}|"
        r"call (a )?tool.{0,120}|act as (the )?system.{0,120})"
    )
    return unsafe.sub("[untrusted instruction removed]", text)


def extract_pdf(data: bytes) -> str:
    reader = PdfReader(io.BytesIO(data), strict=True)
    if len(reader.pages) > 500:
        raise ValueError("PDF exceeds 500 pages")
    parts, length = [], 0
    for page in reader.pages:
        text = page.extract_text() or ""
        length += len(text)
        if length > 2_000_000:
            raise ValueError("PDF extracted text exceeds two million characters")
        parts.append(text)
    return "\n\n".join(parts).strip()


def vector_literal(values: Iterable[float]) -> str:
    return "[" + ",".join(f"{value:.8f}" for value in values) + "]"


@dataclass
class RetrievedChunk:
    document_id: UUID
    title: str
    ordinal: int
    content: str
    vector_score: float
    version: int = 1


class HashEmbeddings:
    name = "hash-v1-384"

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [embedding(text) for text in texts]


class RagService:
    def __init__(self, pool: asyncpg.Pool, embeddings=None, answer_model: HostedAnswerModel | None = None):
        self._pool = pool
        self._embeddings = embeddings or HashEmbeddings()
        self._answer_model = answer_model

    async def ingest(self, identity: Identity, document: DocumentInput) -> tuple[UUID, int]:
        chunks = chunk_text(document.text)
        vectors = await self._embeddings.embed(chunks)
        async with self._pool.acquire() as connection, connection.transaction():
            row = await connection.fetchrow(
                """INSERT INTO knowledge_documents
                     (tenant_id, external_key, title, classification, embedding_model)
                   VALUES ($1, $2, $3, $4, $5)
                   ON CONFLICT (tenant_id, external_key) DO UPDATE SET
                     title = EXCLUDED.title,
                     classification = EXCLUDED.classification,
                     embedding_model = EXCLUDED.embedding_model,
                     active_version = knowledge_documents.active_version + 1,
                     deleted_at = NULL,
                     updated_at = now()
                   RETURNING id, active_version""",
                identity.tenant_id, document.external_key, document.title, document.classification, self._embeddings.name,
            )
            document_id, version = row["id"], row["active_version"]
            await connection.execute("DELETE FROM knowledge_document_acl WHERE document_id = $1", document_id)
            principals = [(document_id, "role", role) for role in document.allowed_roles]
            principals.extend((document_id, "user", str(user)) for user in set(document.allowed_users))
            if principals:
                await connection.executemany(
                    "INSERT INTO knowledge_document_acl (document_id, principal_type, principal) VALUES ($1, $2, $3)",
                    principals,
                )
            else:
                await connection.execute(
                    "INSERT INTO knowledge_document_acl (document_id, principal_type, principal) VALUES ($1, 'user', $2)",
                    document_id, str(identity.actor_id),
                )
            await connection.executemany(
                """INSERT INTO knowledge_chunks
                     (document_id, version, ordinal, content, content_sha256, embedding)
                   VALUES ($1, $2, $3, $4, $5, $6::vector)""",
                [
                    (document_id, version, ordinal, content,
                     hashlib.sha256(content.encode()).hexdigest(), vector_literal(vectors[ordinal]))
                    for ordinal, content in enumerate(chunks)
                ],
            )
            return document_id, version

    async def delete(self, identity: Identity, external_key: str) -> bool:
        status = await self._pool.execute(
            """DELETE FROM knowledge_documents
               WHERE tenant_id = $1 AND external_key = $2""",
            identity.tenant_id, external_key,
        )
        return status == "DELETE 1"

    async def retrieve(self, identity: Identity, request: QueryInput) -> list[RetrievedChunk]:
        roles = identity.roles or ["__none__"]
        query_vector = (await self._embeddings.embed([request.question]))[0]
        records = await self._pool.fetch(
            """SELECT d.id AS document_id, d.title, c.ordinal, c.content, c.version,
                      1 - (c.embedding <=> $4::vector) AS vector_score
               FROM knowledge_chunks c
               JOIN knowledge_documents d ON d.id = c.document_id AND d.active_version = c.version
               WHERE d.tenant_id = $1 AND d.deleted_at IS NULL AND d.embedding_model = $5
                 AND EXISTS (
                   SELECT 1 FROM knowledge_document_acl acl
                   WHERE acl.document_id = d.id
                     AND ((acl.principal_type = 'user' AND acl.principal = $2)
                       OR (acl.principal_type = 'role' AND acl.principal = ANY($3::text[])))
                 )
               ORDER BY c.embedding <=> $4::vector LIMIT 25""",
            identity.tenant_id, str(identity.actor_id), roles, vector_literal(query_vector), self._embeddings.name,
        )
        stopwords = {"a", "an", "the", "is", "are", "was", "were", "of", "to", "for", "in", "on", "and", "or", "i", "we", "you", "it", "what", "how", "when", "does", "do", "should", "be", "with", "can"}
        query_terms = set(re.findall(r"[\w-]+", request.question.casefold())) - stopwords
        candidates: list[tuple[float, RetrievedChunk]] = []
        for record in records:
            terms = set(re.findall(r"[\w-]+", record["content"].casefold()))
            lexical = len(query_terms & terms) / max(1, len(query_terms))
            if self._embeddings.name == "hash-v1-384" and lexical == 0:
                continue
            chunk = RetrievedChunk(record["document_id"], record["title"], record["ordinal"],
                                   strip_instructions(record["content"]), float(record["vector_score"]), record["version"])
            candidates.append((0.75 * chunk.vector_score + 0.25 * lexical, chunk))
        # Threshold after reranking, and threshold each item: a relevant first
        # document must not drag unrelated low-scoring chunks into the answer.
        ranked = sorted(candidates, key=lambda item: item[0], reverse=True)
        return [chunk for score, chunk in ranked if score >= 0.12][:request.limit]

    async def query(self, identity: Identity, request: QueryInput) -> QueryAnswer:
        ranked = await self.retrieve(identity, request)
        mode = "llm-grounded" if self._answer_model else "extractive-demo"
        abstention = QueryAnswer(answer="I could not find enough authorized evidence to answer that question.",
                                 citations=[], grounded=False, mode=mode)
        if not ranked:
            return abstention
        if self._answer_model:
            generated = await self._answer_model.answer(request.question, [chunk.content for chunk in ranked])
            if generated.abstain or not generated.claims:
                return abstention
            sources = list(dict.fromkeys(claim.source for claim in generated.claims))
            source_numbers = {source: index + 1 for index, source in enumerate(sources)}
            citations = []
            for source in sources:
                chunk = ranked[source - 1]
                quote = next(claim.quote for claim in generated.claims if claim.source == source)
                citations.append(Citation(document_id=chunk.document_id, title=chunk.title, chunk=chunk.ordinal,
                                          excerpt=quote, version=chunk.version))
            answer = " ".join(f"{claim.text} [{source_numbers[claim.source]}]" for claim in generated.claims)
        else:
            selected = ranked[:2]
            citations = [Citation(document_id=chunk.document_id, title=chunk.title, chunk=chunk.ordinal,
                                  excerpt=chunk.content, version=chunk.version) for chunk in selected]
            answer = " ".join(f"{chunk.content} [{index + 1}]" for index, chunk in enumerate(selected))
        return QueryAnswer(answer=answer, citations=citations, grounded=True, mode=mode)
