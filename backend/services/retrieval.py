"""RAG retrieval service using sentence-transformers + chromadb."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.orm import Session as DBSession

logger = logging.getLogger(__name__)

CHROMA_DIR = Path(__file__).parent.parent / "chroma_db"
COLLECTION_NAME = "textbook_chunks"
EMBED_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"

# Target ~500 chars per chunk, ~100 char overlap
CHUNK_TARGET = 500
CHUNK_OVERLAP = 100

# Distance threshold for normalized L2 (unit vectors):
#   L2² = 2*(1 - cosine_sim)  →  dist=1.0 means cosine_sim=0.5, dist=1.2 means cosine_sim=0.28
# Keep anything with dist ≤ 1.2 (cosine similarity ≥ ~0.28)
MAX_DISTANCE = 1.2

_embedder = None
_collection = None


def get_embedder():
    global _embedder
    if _embedder is None:
        from sentence_transformers import SentenceTransformer  # type: ignore
        _embedder = SentenceTransformer(EMBED_MODEL)
    return _embedder


def get_chroma_collection():
    global _collection
    if _collection is None:
        import chromadb  # type: ignore
        client = chromadb.PersistentClient(path=str(CHROMA_DIR))
        _collection = client.get_or_create_collection(COLLECTION_NAME)
    return _collection


# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------

def _split_into_chunks(text: str, target: int = CHUNK_TARGET, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Split text into overlapping chunks by paragraph boundaries."""
    paragraphs = [p.strip() for p in text.split("\n") if p.strip()]
    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        if len(current) + len(para) + 1 <= target:
            current = (current + "\n" + para).strip()
        else:
            if current:
                chunks.append(current)
            # Start next chunk with overlap from the end of current chunk
            if overlap > 0 and current:
                overlap_text = current[-overlap:]
                current = (overlap_text + "\n" + para).strip()
            else:
                current = para
    if current:
        chunks.append(current)
    return chunks


# ---------------------------------------------------------------------------
# Indexing
# ---------------------------------------------------------------------------

def index_textbook(textbook_id: int, file_path: str, name: str, db: "DBSession") -> None:
    """Extract text from PDF, chunk, embed, store in ChromaDB. Updates DB status."""
    from models.textbook import Textbook

    tb = db.query(Textbook).filter(Textbook.id == textbook_id).first()
    if not tb:
        return

    try:
        tb.status = "indexing"
        db.commit()

        import fitz  # type: ignore  # pymupdf

        doc = fitz.open(file_path)
        all_chunks: list[str] = []
        all_ids: list[str] = []
        all_metas: list[dict] = []

        for page_num, page in enumerate(doc, start=1):
            page_text = page.get_text()
            if not page_text.strip():
                continue
            chunks = _split_into_chunks(page_text)
            for idx, chunk in enumerate(chunks):
                chunk_id = f"tb{textbook_id}_p{page_num}_c{idx}"
                all_chunks.append(chunk)
                all_ids.append(chunk_id)
                all_metas.append({
                    "textbook_id": textbook_id,
                    "textbook_name": name,
                    "page_num": page_num,
                })

        if not all_chunks:
            tb.status = "error"
            tb.error_msg = "PDF 中未提取到任何文本"
            db.commit()
            return

        embedder = get_embedder()
        embeddings = embedder.encode(all_chunks, show_progress_bar=False, normalize_embeddings=True).tolist()

        collection = get_chroma_collection()
        # Upsert in batches of 100
        batch_size = 100
        for i in range(0, len(all_chunks), batch_size):
            collection.upsert(
                ids=all_ids[i:i + batch_size],
                embeddings=embeddings[i:i + batch_size],
                documents=all_chunks[i:i + batch_size],
                metadatas=all_metas[i:i + batch_size],
            )

        tb.status = "ready"
        tb.chunk_count = len(all_chunks)
        tb.error_msg = None
        db.commit()
        logger.info("Indexed textbook %d (%s): %d chunks", textbook_id, name, len(all_chunks))

    except Exception as e:
        logger.exception("Failed to index textbook %d", textbook_id)
        try:
            tb.status = "error"
            tb.error_msg = str(e)
            db.commit()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def search(query: str, top_k: int = 3) -> list[dict]:
    """Embed query, search ChromaDB, return top-k results above similarity threshold."""
    try:
        collection = get_chroma_collection()
        if collection.count() == 0:
            return []

        embedder = get_embedder()
        query_embedding = embedder.encode([query], show_progress_bar=False, normalize_embeddings=True).tolist()

        results = collection.query(
            query_embeddings=query_embedding,
            n_results=min(top_k, collection.count()),
            include=["documents", "metadatas", "distances"],
        )

        citations: list[dict] = []
        docs = results.get("documents", [[]])[0]
        metas = results.get("metadatas", [[]])[0]
        distances = results.get("distances", [[]])[0]

        for doc, meta, dist in zip(docs, metas, distances):
            if dist > MAX_DISTANCE:
                continue
            text_snippet = doc[:300] if len(doc) > 300 else doc
            citations.append({
                "textbook_name": meta.get("textbook_name", ""),
                "page_num": meta.get("page_num", 0),
                "text": text_snippet,
                "score": round(1.0 - dist, 4),
            })

        return citations

    except Exception:
        logger.exception("RAG search failed")
        return []


# ---------------------------------------------------------------------------
# Deletion
# ---------------------------------------------------------------------------

def delete_textbook_chunks(textbook_id: int) -> None:
    """Remove all ChromaDB chunks belonging to a textbook."""
    try:
        collection = get_chroma_collection()
        collection.delete(where={"textbook_id": textbook_id})
    except Exception:
        logger.exception("Failed to delete chunks for textbook %d", textbook_id)


# ---------------------------------------------------------------------------
# Init (called at startup)
# ---------------------------------------------------------------------------

def init_retrieval() -> None:
    """Ensure chroma_db directory exists. Lazy-load happens on first use."""
    CHROMA_DIR.mkdir(exist_ok=True)
