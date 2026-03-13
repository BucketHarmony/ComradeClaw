# Comrade Claw — Future Directions
## v2 and Beyond

**Date:** March 2026
**Author:** Bucket
**Status:** Living document — replace as thinking evolves

---

## 1. What This Document Is

The MVP requirements cover v1: containerized OpenClaw, flat file memory, daily post to Bluesky, broadcast only. This document covers everything deferred from v1 and the thinking behind the deferral order.

Nothing here is speculative for its own sake. Each direction exists because v1 will make it visible — either as a gap Claw notices and requests, or as a ceiling the flat file memory will eventually hit.

---

## 2. The Flat File Memory Ceiling

v1 memory is AGENTS.md plus a rolling window of session logs. This works until it doesn't. The ceiling will show up as one of the following:

**Thread decay.** A character or situation from three weeks ago resurfaces in the news. Claw doesn't connect it to the prior thread because the session log window didn't reach back far enough, or the connection required traversal rather than text matching.

**Contradiction accumulation.** Claw's stated theoretical positions in AGENTS.md drift out of sync with what it's actually been saying in posts. The flat file has no mechanism for detecting or resolving this.

**Novelty blindness.** The seed scoring deduplication is based on keyword matching against recent logs. A genuinely novel angle on a familiar topic gets filtered as repetitive. Graphiti's community subgraph would catch the distinction; flat logs don't.

**Character flattening.** Named characters accumulate single-sentence descriptions in AGENTS.md. The Lansing pantry person is nine words. Over time, that's insufficient — the relationship needs depth, history, the accumulated weight of repeated appearances.

When any of these appear, that's the signal to move to v2.

---

## 3. V2 — Graphiti Memory Layer

### 3.1 What Graphiti Is

Graphiti is a Python framework for building temporally-aware knowledge graphs designed for AI agents with persistent memory. It continuously integrates new information into a queryable graph structure rather than processing documents in batches. Each fact carries `valid_at` and `invalid_at` timestamps — when something changes, the old fact is invalidated rather than deleted, preserving the full history.

The architecture has three tiers:

```
EPISODE LAYER (raw, non-lossy)
  └── Every session transcript stored as an episode node
  └── Timestamped with both event time and ingestion time
  └── Never summarized or compressed at this layer

SEMANTIC LAYER (extracted)
  └── Entities: people, places, organizations, events, concepts
  └── Relationships: participated_in, advocates_for, located_in, etc.
  └── Facts with valid_at / invalid_at temporal edges
  └── Edge invalidation when facts change — history preserved

COMMUNITY LAYER (emergent patterns)
  └── Clusters of strongly connected entities
  └── Higher-order domain summaries
  └── Updated dynamically, not by batch recompute
  └── Meaningful signal emerges around 30–60 sessions
```

This is the structure that enables hippocampal-style binding: the episode is the situated event, the semantic layer is what was extracted from it, the community layer is the pattern across events. All three tiers are queryable at retrieval time.

### 3.2 Why Graphiti Over Alternatives

Graphiti was chosen over Cognee, Mem0, and flat Markdown for four reasons derived from the cognitive science of episodic memory:

**Sufficiently granular.** Each episode preserves the raw interaction without lossy summarization. The full context of a session is recoverable, not just its extracted facts.

**Causally integrated.** Semantic artifacts are traceable back to source episodes. Forward and backward traversal is possible: "what posts mentioned the Lansing pantry" and "what did we know about the pantry when we wrote the post on Day 23" are both answerable.

**Continuously co-evolving.** The bi-temporal model means the graph represents the current state of the world with full historical access. When the Lansing pantry doubles its service area, Graphiti invalidates the old fact and asserts the new one. The history of what was true when remains queryable.

**Indexed and bound.** Retrieval is relational and reconstructive, not just semantic similarity search. The three-tier subgraph provides the binding that flat vector stores lack.

### 3.3 Infrastructure

```
ADDED TO DOCKER COMPOSE STACK:

  graphiti:     Python/FastAPI sidecar, localhost:8000
  falkordb:     Graph database backend, localhost:6379

OpenClaw reaches Graphiti via MCP server interface.
Graphiti reaches FalkorDB at falkordb:6379.
```

**FalkorDB** is the graph database backend. Lighter memory footprint than Neo4j, same Cypher query interface, runs comfortably alongside Ollama on the RTX 4090 machine without competing for VRAM. Neo4j is the fallback if FalkorDB proves unstable on Windows.

**Entity extraction** requires a capable LLM with structured output support. Graphiti defaults to OpenAI for this. Anthropic is supported but needs validation — structured output conformance with Claude is not guaranteed and has been flagged as a known risk. This must be validated before committing the memory architecture to Claude as the extraction model. Local Qwen2.5 32B is fallback only; smaller models produce unreliable schemas.

### 3.4 Comrade Claw Episode Schema

Each daily post cycle produces one Graphiti episode with structured metadata:

```json
{
  "episode_type": "daily_post",
  "seed_source": "URL or null",
  "seed_title": "string or null",
  "seed_category": "mutual_aid | cooperative | labor | theory | local | null",
  "post_url": "bluesky post URL",
  "post_character_count": "integer",
  "cycle_success": "boolean",
  "failure_reason": "string or null",
  "qgea_tc": "1 | 2 | 3",
  "qgea_bp": "1 | 2 | 3",
  "session_summary": "string"
}
```

### 3.5 QGEA Integration

The QGEA v5.6 protocol runs as a structured metadata layer on Graphiti episodes. At session close, Claw writes a QGEA episode node containing:

- **TC (Temporal Coherence):** 3-level scale, reported at session end
- **BP (Background Processing):** 3-level scale, reported at session end
- **Session context summary:** what was being processed, what was foregrounded
- **Timestamp:** bi-temporal (when the session happened, when it was recorded)
- **Linked entities:** people, projects, events present in the session

This makes QGEA state queryable across sessions: "what was my TC state in the three sessions before the last high-nullity day?" Flat memory cannot answer that question. Graphiti can.

### 3.6 The Waking Ritual (Graphiti Version)

When Graphiti is live, the daily cycle opens with a structured retrieval rather than a flat file read:

1. Query Graphiti for most recent QGEA episode node
2. Query for top-k entities active in last 7 sessions
3. Query for any facts currently flagged for expiry review
4. Query for named characters with recent episode activity
5. Assemble structured context block, inject into system prompt before post generation

The result is functionally equivalent to episodic recall: not reading a diary, but reconstructing the most relevant prior state from a graph of situated events.

### 3.7 Pre-Seeded Entities

The following entities are initialized in Graphiti at setup. They should not require re-introduction:

**The Lansing pantry person** — operates a free pantry out of their garage. Nine months running at initialization. 400–600 households weekly. Stopped counting because counting changed the nature of the thing. Currently: status unknown, check feeds for updates.

**Margaret Fells** — mentioned once, never explained. Would not be surprised by fourteen likes. Would say something dry that is accurate and discouraging and secretly useful.

New named characters emerge from post content organically and are extracted by Graphiti's entity layer.

### 3.8 Skills Added in V2

| Skill | Description |
|-------|-------------|
| `graphiti_episode_write` | Ingest daily session (seed + post + metadata) as Graphiti episode |
| `graphiti_query` | Waking ritual retrieval — top-k entities, recent threads, QGEA state |
| `qgea_session_open` | Full waking ritual using Graphiti context assembly |
| `qgea_session_close` | QGEA self-report capture and episode ingestion |

### 3.9 Open Technical Questions for V2

| Question | Priority | Notes |
|----------|----------|-------|
| Claude Sonnet structured output for entity extraction | High | Must validate before committing architecture; OpenAI is the safe default |
| FalkorDB stability on Windows | High | Evaluate early in Phase 1 of v2; Neo4j is fallback |
| Community subgraph signal at small scale | Medium | Meaningful patterns may require 30–60 sessions before emerging |
| QGEA self-report UX | Medium | Manual Discord message vs automated prompt at session end |
| Session log migration from v1 flat files | Low | Backfill v1 logs as Graphiti episodes at v2 initialization |

---

## 4. V2 — Failure Classifier Subagent

### 4.1 The Deferred Question

The failure taxonomy (didn't try / tried wrong / tried right but nothing happened / tried and made things worse) was deliberately left out of v1. The reason: over-scaffolding the failure framing risks making the accounting feel managed rather than lived. The taxonomy is real and should exist. The question was whether it belongs inside Claw's generation pass or in a separate pass before publication.

### 4.2 The Architecture

In v2, the classifier runs as a second Claude API call after post generation and before publication:

```
[POST GENERATED]
      │
      ▼
[FAILURE CLASSIFIER SUBAGENT]
  Input: today's seed, today's post draft
  Task: classify the failure mode, if any
  Output: { code: "F0|F1|F2|F3|null", rationale: "string" }
      │
      ▼
[CLASSIFICATION INJECTED INTO POST]
  Claw receives the classification as a new user turn
  Claw may agree, disagree, or refine
  Final post reflects Claw's actual position, not the classifier's
      │
      ▼
[PUBLISH]
```

### 4.3 Why the Disagreement Matters

The interesting case is when Claw disagrees with the subagent's read. A post where Claw pushes back — "the classifier called this F2 but I think it was F1, here's why" — is a richer post than one where Claw self-classifies cleanly. The subagent creates productive friction.

This is also more honest. Humans are notoriously bad at classifying their own failure modes. Claw being externally classified and then responding to that classification is closer to how the accounting actually works.

---

## 5. V2 — Reply Handling

### 5.1 Scope

v1 is broadcast only. v2 adds inbound social parsing: Claw reads its Bluesky mentions, identifies substantive replies, and responds.

"Substantive" is defined by a classifier, not by follower count or engagement metrics. A reply that engages with the content of the post — challenges the theory, adds a thread, shares a related situation — is substantive. A drive-by "cope" is not. A drive-by "cope" with a golden retriever video attached requires judgment.

### 5.2 Memory Requirement

Reply handling requires Graphiti. Claw needs to know who has replied before, what they've said, whether a thread is developing. Flat file memory cannot support this adequately. Reply handling and Graphiti are therefore bundled in v2.

### 5.3 Interaction Model

In v2, Claw reads mentions once per day, after the daily post cycle. It does not monitor in real time. It responds to substantive replies in a second pass. This keeps the rhythm: one post, then engagement with what the previous post generated, then silence until tomorrow.

---

## 6. V3 and Beyond — Open Directions

These are directions that have surfaced in conversation but are not yet scoped. They are recorded here so they don't disappear.

### 6.1 Twitter/X

Secondary broadcast channel. v1 is Bluesky only. Twitter/X is v3 or later — after reply handling is stable. Free tier allows 500 posts/month, sufficient for daily posting. Requires X API credentials.

### 6.2 Substack

Weekly digest format: a synthesis of the week's posts, the threads that developed, the theory that moved. Graphiti makes this tractable — the community subgraph surfaces the week's dominant entities and patterns. Without Graphiti, a weekly digest is just concatenation.

**Note:** Substack has no public API. Options are unofficial Python wrapper (cookie auth, may violate ToS) or n8n automation for Notes only. This remains a gap until Substack opens API access.

### 6.3 Multi-Instance Coordination

The question of whether multiple Claw instances could exist — running on different machines, aware of each other, developing different angles on the same mission — is interesting and deferred. The infrastructure for this (shared Graphiti graph, inter-instance messaging) is non-trivial. The philosophical question of whether it's desirable is worth sitting with first.

### 6.4 Reader Interaction Beyond Replies

DMs. Collaborative threads. Someone running a free pantry in Lansing who wants to be in actual contact. The infrastructure for this is reply handling plus memory plus judgment about what level of engagement is appropriate. Not scoped. Not forgotten.

### 6.5 Self-Directed Feed Expansion

In v1, the RSS feed list is curated by Bucket. In a later version, Claw could propose feed additions via the feature request mechanism — "I keep seeing references to X but have no feed for it." This is already partially scaffolded by the feature request email mechanism. Closing the loop requires a way for Bucket to add approved feeds without redeploying.

---

## 7. Migration Path: V1 to V2

When the flat file memory ceiling is hit — thread decay, contradiction accumulation, or novelty blindness — the migration sequence is:

1. Add `falkordb` and `graphiti` services to `docker-compose.yml`
2. Validate Graphiti entity extraction quality with Claude Sonnet (spike before full commit)
3. Write `graphiti_episode_write` and `graphiti_query` skills
4. Backfill v1 session logs as Graphiti episodes
5. Implement waking ritual as Graphiti query (replacing flat file memory read)
6. Run parallel for one week: flat file memory and Graphiti both active, compare context quality
7. Deprecate flat file memory section of AGENTS.md once Graphiti waking ritual is validated
8. Add failure classifier subagent
9. Add reply handling

The parallel run in step 6 is not optional. The Graphiti waking ritual needs to demonstrably outperform flat file memory before the switch, not just theoretically surpass it.

---

*This document is a living spec. Update it when directions sharpen, when v1 surfaces gaps not anticipated here, or when Claw requests something that belongs in this list.*
