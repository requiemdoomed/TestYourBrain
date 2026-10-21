"""Write tests/fixtures/parity.json from the original Python backend, so the JavaScript port can be
checked against it (sentence splitting, chunking, hashing vectors, key terms, topic splitting, fuzzy scores).

Run from the TestYourBrain-web folder with the backend's virtualenv:
    ../TestYourBrain/backend/.venv/bin/python scripts/make_parity_fixtures.py ../TestYourBrain/backend
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

backend = Path(sys.argv[1] if len(sys.argv) > 1 else "../TestYourBrain/backend").resolve()
sys.path.insert(0, str(backend))

import numpy as np  # noqa: E402
from langchain_text_splitters import RecursiveCharacterTextSplitter  # noqa: E402
from rapidfuzz import fuzz  # noqa: E402

from app.services import topics as topics_mod  # noqa: E402
from app.services.embeddings import HashingEmbeddings  # noqa: E402
from app.services.extraction import extract  # noqa: E402
from app.services.offline_generator import TermBank, _swap_term  # noqa: E402
from app.services.text_utils import normalize_answer, paragraphs, sentences  # noqa: E402

samples = Path(__file__).resolve().parent.parent / "samples"
splitter = RecursiveCharacterTextSplitter(
    chunk_size=900, chunk_overlap=120, separators=["\n\n", "\n", ". ", "; ", ", ", " ", ""]
)
hashing = HashingEmbeddings()

docs = []
for path, ftype in [
    ("operating-systems-notes.pdf", "pdf"),
    ("biology-energy-in-cells.pptx", "pptx"),
    ("industrial-revolution.docx", "docx"),
    ("networking-basics.md", "md"),
]:
    result = extract(samples / path, ftype)
    chunks = []
    for seg in result.segments:
        for piece in splitter.split_text(seg.text):
            piece = piece.strip()
            if len(piece) >= 15:
                chunks.append({"text": piece, "title": seg.title, "location": seg.location})
    texts = [c["text"] for c in chunks]
    titles = [c["title"] for c in chunks]
    vectors = np.asarray(
        hashing.embed_documents([f"{c['title']}\n{c['text']}" if c["title"] else c["text"] for c in chunks]),
        dtype=np.float32,
    )
    spans = [topics_mod.TopicSpan(a, b) for a, b in topics_mod.segment(vectors, titles, [c["location"] for c in chunks], texts, result.unit)]
    topics_mod.name_offline(spans, texts, titles)
    bank = TermBank.build(texts, [k for s in spans for k in s.keywords])
    docs.append(
        {
            "file": path,
            "unit": result.unit,
            "segments": [{"text": s.text, "title": s.title, "location": s.location} for s in result.segments],
            "chunks": chunks,
            "segment_bounds": [[s.start, s.end] for s in spans],
            "topic_names": [s.name for s in spans],
            "topic_keywords": [s.keywords for s in spans],
            "terms": dict(bank.kinds),
            "definitions": dict(bank.definitions),
            "sentences": [sentences(t) for t in texts],
            "complete_sentences": [sentences(t, complete_only=True) for t in texts],
            "paragraphs": [paragraphs(t) for t in texts],
            "hash_nonzero": [[int(i) for i in np.nonzero(v)[0]] for v in vectors[:5]],
            "hash_values": [[round(float(v[i]), 6) for i in np.nonzero(v)[0]] for v in vectors[:5]],
        }
    )

rng = random.Random(7)
words = "process thread memory page cell energy glucose the a of in scheduling round robin".split()
pairs = []
for _ in range(60):
    a = " ".join(rng.choice(words) for _ in range(rng.randint(1, 8)))
    b = " ".join(rng.choice(words) for _ in range(rng.randint(3, 25)))
    pairs.append(
        {"a": a, "b": b, "ratio": fuzz.ratio(a, b), "partial": fuzz.partial_ratio(a, b), "token_set": fuzz.token_set_ratio(a, b)}
    )

answers = ["The CPU!", "  an Operating   System ", "3.14 seconds.", "e.g. RuBisCO", "50% of the time", "Round-robin"]
swaps = [
    ("The stroma is the fluid inside the chloroplast.", "stroma", "thylakoids"),
    ("A semaphore is an integer variable used to control access.", "semaphore", "mutexes"),
    ("Threads are lightweight processes.", "Threads", "integer variable"),
]

out = {
    "docs": docs,
    "fuzz": pairs,
    "normalize": {a: normalize_answer(a) for a in answers},
    "swaps": [[s, o, n, _swap_term(s, o, n)] for s, o, n in swaps],
    "split": [splitter.split_text(d["segments"][0]["text"] * 3) for d in docs],
}
dest = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "parity.json"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out, indent=1, ensure_ascii=False))
print(f"Wrote {dest} ({dest.stat().st_size // 1024} KB)")
