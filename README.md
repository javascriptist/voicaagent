# Voice AI restaurant reservations

Backend for a Vonage AI Studio voice agent that answers a restaurant's phone line
and calls these HTTP endpoints during the call.

TypeScript · Node 20 · Fastify · PostgreSQL 16 + pgvector · Prisma · Redis · Zod · Vitest

---

## The three things that matter

**A caller is on the phone.** Vonage AI Studio's Webhook node falls into its error
branch at five seconds — that is a dropped call, not a slow one. Every endpoint
targets a 500 ms p95 and CI fails the build if any voice endpoint exceeds 1500 ms.
There is no synchronous model call anywhere in the availability path; the engine is
a pure function over an in-memory snapshot and answers a realistic query in about
7 ms.

**Double bookings are impossible, not unlikely.** Redis holds stop two callers being
*offered* the same table. They are an optimisation. The guarantee is an exclusion
constraint in Postgres:

```sql
EXCLUDE USING gist (table_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status IN ('held', 'confirmed', 'seated'))
```

Fifty parallel bookings at one table: exactly one succeeds. The other forty-nine
hear "sorry, that table has just gone."

**speech_hint is read aloud verbatim.** AI Studio pipes it straight into a Speak
node with no model in between to rephrase it. So: words only. `"seven thirty"`,
never `"19:30"`. No digits, no ids, no markdown, no lists. Every builder ends in
`assertSpeechSafe`, and the test suite checks every endpoint and every error path
against `/^[\p{L} ,.'?-]+$/u`.

---

## Setup

```bash
git clone <this repo> && cd aicallcenter
npm install
cp .env.example .env

docker compose up -d              # postgres:5433 (pgvector), redis:6380
npm run prisma:migrate            # schema + exclusion constraint + HNSW index
npm run db:seed                   # the demo restaurant

npm run dev                       # http://localhost:3000
```

Everything runs without an API key. With `OPENAI_API_KEY` empty the system uses a
deterministic offline embedder, so retrieval works end to end for development and
tests; set the key for real semantic search.

```bash
npm test                 # 146 unit tests, integration tests skip without docker
npm run test:integration # needs postgres + redis
npm run typecheck
npm run openapi          # regenerates openapi.json from the Zod schemas
```

### The demo restaurant

`npm run db:seed` creates **The Tasting Room** (`the-tasting-room`, `Europe/London`):
two floors, twenty tables, two service periods, and knowledge documents covering
policies, menu, FAQs and the layout.

The floor plan is built so every engine path has something to find:

| | |
|---|---|
| `W1`–`W4` | window banquettes, a combinable run for large parties |
| `B1`–`B3` | booths, quiet, fixed seating (so no wheelchair transfer) |
| `A1` `A2` | wheelchair accessible with clearance, ground floor |
| `BAR1`–`BAR3` | high stools, next to the speakers, loud |
| `TR1`–`TR3` | terrace, combinable, `TR3` accessible |
| `M1` `M2` `PDR` | mezzanine and private room — **stairs only, never step-free** |

```
admin login   owner@tastingroom.test / demo-password-1234
hmac secret   demo-secret-change-me-in-production
```

---

## Voice endpoints

All under `/v1/voice`, all signature verified, all writes idempotent.

### Authentication

Vonage AI Studio signs each webhook with an HS256 JWT in `Authorization: Bearer`,
carrying `iat`, `jti` and `payload_hash` (SHA-256 of the raw body). All three are
checked against the restaurant's own secret:

- the **signature** proves Vonage sent it,
- **`payload_hash`** binds the token to *this* body — without it a token lifted
  from a harmless webhook can be replayed over a cancel-booking body,
- **`iat`** inside a five minute window stops a captured request being replayed later.

`WEBHOOK_AUTH=hmac` selects a generic `X-Signature: v1=<hex>` / `X-Timestamp`
scheme instead, which is what the curl examples below use so you can try them
without a Vonage account. `both` (the default) accepts either.

```bash
# Sign a request the generic way.
sign() {
  BODY="$1"; SECRET="${2:-demo-secret-change-me-in-production}"
  TS=$(date +%s)
  SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/.* //')
  printf '%s %s' "$TS" "$SIG"
}
post() {
  BODY="$2"; read -r TS SIG <<< "$(sign "$BODY")"
  curl -sS -X POST "http://localhost:3000/v1/voice/$1" \
    -H 'content-type: application/json' \
    -H 'x-restaurant: the-tasting-room' \
    -H "x-timestamp: $TS" -H "x-signature: v1=$SIG" \
    ${3:+-H "idempotency-key: $3"} \
    -d "$BODY"
}
```

### `POST /check-availability`

Runs the engine and takes a 180 second Redis hold on whatever it offers.

```bash
post check-availability '{
  "call_id": "call-001",
  "party_size": 2,
  "date": "2026-08-14",
  "time": "19:30",
  "accessibility": [],
  "seating_preferences": ["booth", "quiet"],
  "flexibility_minutes": 60
}'
```

```json
{
  "ok": true,
  "available": true,
  "speech_hint": "Seven thirty works, and I can give you a booth and a quiet table.",
  "reason": null,
  "large_party": false,
  "turn_time_minutes": 90,
  "offer": {
    "starts_at": "2026-08-14T18:30:00.000Z",
    "local_time": "19:30",
    "spoken_time": "seven thirty",
    "table": { "table_labels": ["B1"], "is_combination": false, "zone": "main", "seats": 4 }
  },
  "alternatives": [ ... ],
  "hold": { "held": true, "expires_at": "2026-08-14T18:03:00.000Z", "table_ids": ["..."] }
}
```

### `POST /create-booking`

Consumes the hold inside a transaction. `Idempotency-Key` is **required**.

```bash
post create-booking '{
  "call_id": "call-001",
  "party_size": 2,
  "date": "2026-08-14",
  "time": "19:30",
  "guest_name": "Sam Okafor",
  "phone": "+447700900123",
  "accessibility": [],
  "seating_preferences": ["booth"],
  "allergies_verbatim": "severe nut allergy, both of us",
  "occasion": "anniversary"
}' 'call-001-booking-1'
```

The allergy is stored exactly as the guest said it and read back in the
`speech_hint` — the last chance to catch a mishearing before it reaches the kitchen.

### `POST /lookup-booking`

```bash
post lookup-booking '{"call_id": "call-002", "phone": "+447700900123"}'
```

### `POST /modify-booking`

Re-runs availability ignoring the booking's own occupancy, so moving it half an
hour is not blocked by itself.

```bash
post modify-booking '{
  "call_id": "call-002",
  "reservation_id": "REPLACE_WITH_ID",
  "time": "20:00",
  "party_size": 4
}' 'call-002-modify-1'
```

### `POST /cancel-booking`

Cancelling an already cancelled booking succeeds — the guest's intent is satisfied
and the agent may retry.

```bash
post cancel-booking '{
  "call_id": "call-003",
  "phone": "+447700900123",
  "reason": "plans changed"
}'
```

### `POST /search-knowledge`

Vector search scoped to the restaurant, then a lexical rerank. Query embeddings are
cached in Redis for a day.

```bash
post search-knowledge '{
  "call_id": "call-004",
  "query": "do you have step free access",
  "top_k": 4
}'
```

This answers without anyone having written an FAQ: accessibility, hours and zone
documents are **generated from the floor plan** on every structural write.

### `POST /join-waitlist`

```bash
post join-waitlist '{
  "call_id": "call-005",
  "guest_name": "Priya Raman",
  "phone": "+447700900456",
  "date": "2026-08-15",
  "window_start": "19:00",
  "window_end": "21:00",
  "party_size": 4,
  "accessibility": [],
  "seating_preferences": []
}' 'call-005-waitlist-1'
```

### `POST /create-enquiry`

```bash
post create-enquiry '{
  "call_id": "call-006",
  "category": "private_hire",
  "guest_name": "Dan Levy",
  "phone": "+447700900789",
  "message": "Can we hire the private room for twelve on the third?"
}' 'call-006-enquiry-1'
```

### `POST /call-events`

Call started, ended, transcript, recording. Events arrive out of order and more
than once, so this upserts and only ever fills fields in.

```bash
post call-events '{
  "call_id": "call-001",
  "event": "call_ended",
  "outcome": "booked",
  "recording_url": "https://api.nexmo.com/v1/files/abc",
  "transcript": [{"role": "caller", "text": "table for two on friday"}]
}'
```

---

## Admin and public

`/v1/admin` is JWT authenticated and **scoped by the token, never by the URL** — a
route that took a restaurant id from the request would let any operator read
another tenant's bookings by editing a path parameter.

```bash
TOKEN=$(curl -sS -X POST localhost:3000/v1/admin/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@tastingroom.test","password":"demo-password-1234"}' | jq -r .token)

curl -sS localhost:3000/v1/admin/tables -H "authorization: Bearer $TOKEN" | jq
```

CRUD for floors, tables, service periods, closures and table blocks;
`POST /floors/:id/import` takes a layout from the front-end editor in one
transaction and refuses to delete a table that has an upcoming booking;
`GET /reservations`, `/calls`, `/waitlist`, `/enquiries` for the read models.

`/v1/public` serves the web booking widget through **the same availability engine
and the same BookingService as the phone** — two code paths would eventually
disagree about whether a table is free, and the disagreement would be a double
booking between a web guest and a caller.

```bash
curl -sS localhost:3000/v1/public/the-tasting-room | jq
```

---

## The availability engine

`src/availability/` is pure. No database, no Redis, no clock, no network — `now`
is a parameter. That is what makes DST gaps, combination search and the
accessibility filter testable without standing up Postgres, and it is what keeps
the latency budget honest.

1. **Slots** from service periods, closures and `booking_window_days`. The grid is
   generated in wall-clock minutes and only then converted to instants, which is
   what makes DST behave.
2. **Turn time** from `default_turn_times`, bracketing *downwards* by party size,
   overridable per service period.
3. **Hard filter** — capacity between `min_covers` and `max_covers`, no overlapping
   reservation, hold or block, and every accessibility requirement satisfied.
4. **Combinations** if no single table fits: connected runs of up to three
   combinable tables in one zone. Connectivity, not cliques — A–B–C works even
   though A and C are not directly combinable.
5. **Score** the survivors:

   | term | weight | why |
   |---|---|---|
   | preference match | `+10` each | what the guest asked for |
   | capacity waste | `-3` per empty cover | a two-top beats a six-top for two |
   | zone balance | `-1` per lost cover, capped at 8 | don't break a run a party of nine needs later |
   | accessibility reserve | `-15` per accessible table | keep them free for guests who need them |

   Weights share one scale so the trade-offs are readable: one preference (+10) is
   worth about three wasted covers (−9), and an accessible table is never given
   away for a single nice-to-have (−15 beats +10).

6. **Hold** in Redis at `hold:{restaurant}:{table}:{slot}`, TTL 180s, value is the
   call id — so a caller re-checking mid-call is not blocked by their own hold.

### Accessibility is never traded away

Requirements are pass/fail and are applied before scoring, to every table of a
combination, and to every alternative and next-date suggestion. A `wheelchair_space`
request never returns a table without clearance — not when the restaurant is empty,
not when it is the last table in the building. `wheelchair_space` also *implies*
step-free: a perfect table up a staircase is not a usable table.

### Timezones

All times stored UTC `timestamptz`; all input and output in the restaurant's IANA
zone.

- **Spring forward** — `02:30` does not exist on the transition date. Luxon would
  silently hand back `03:30`; we detect the gap and refuse, then offer the real
  times either side. Telling a guest "half two" and booking half three is the bug
  this prevents.
- **Fall back** — `01:30` happens twice. We offer the first occurrence, and never
  do duration arithmetic in wall-clock terms: a two hour booking at `01:00` ends at
  `02:00` by the clock and has still held the table for exactly 120 minutes.

---

## Tests

```
test/unit/          146 tests, no IO, run anywhere
test/integration/   need postgres + redis; skip with a message otherwise
```

Set `DB_REQUIRED=1` in CI to turn a missing database into a failure rather than a skip.

| test | file |
|---|---|
| 50 parallel bookings, exactly one wins | `integration/booking.test.ts` |
| accessibility is a hard filter | `unit/engine.test.ts`, `integration/booking.test.ts` |
| turn time overlap (2h at 19:00 blocks 20:30) | `unit/engine.test.ts` |
| DST spring-forward gap and autumn repeat | `unit/dst.test.ts`, `integration/voice-contract.test.ts` |
| tenant isolation (A cannot read B) | `integration/booking.test.ts` |
| idempotency, including the race | `integration/booking.test.ts` |
| hold expiry frees the slot | `integration/booking.test.ts` |
| table combination for a party of nine | `unit/engine.test.ts` |
| speech_hint speakable on every endpoint | `unit/speech.test.ts`, `integration/voice-contract.test.ts` |
| no voice endpoint over 1500 ms | `integration/voice-contract.test.ts` |
| webhook JWT replay and tampering | `integration/voice-contract.test.ts` |

---

## Layout

```
prisma/
  schema.prisma                  the data model
  migrations/…_hard_guarantees/  exclusion constraint, sync trigger, HNSW index
  seed.ts                        the demo restaurant
src/
  availability/                  the pure engine — no IO, no clock, no network
  booking/                       transactional writes; where concurrency is decided
  domain/                        attributes, accessibility, preferences
  holds/                         Redis holds (advisory)
  http/                          Fastify app, routes, Zod schemas
  knowledge/                     chunking, embedding, retrieval, generated docs
  notify/                        Notifier interface + Vonage, Twilio, no-op
  speech/                        the speech_hint contract and its guard
  time/                          the only place wall clock and UTC meet
```

### Swapping the embedding provider

Everything imports `Embedder` and `Reranker` from `src/knowledge/embedder.ts` and
nothing imports a provider directly, so a swap is one file and one env var. The
current implementation is OpenAI `text-embedding-3-small` asking for **1024
dimensions**, which keeps the `vector(1024)` column and its HNSW index unchanged.
`NoopEmbedder` is deterministic and offline, and is what the tests use.

There is no reranking model at OpenAI, so the second stage is lexical and runs
in-process — deliberate, since a network round trip to a reranker would sit inside
the five second webhook ceiling.

---

## Operations

One structured log line per tool call, so the slow path is a filter rather than a grep:

```json
{"level":"info","kind":"tool_call","tool":"check_availability",
 "restaurant_id":"…","call_id":"call-001","latency_ms":34,"ok":true,"status":200}
```

Anything over 400 ms logs at `warn` — already three quarters of the p95 budget.
Signatures, tokens and password hashes are redacted by pino; SMS bodies are never
logged, because they contain the guest's name and booking time.

`GET /health` is deliberately shallow — a health check that queries Postgres flaps
whenever the database has a slow second and takes the phone line with it.
`GET /ready` checks Postgres and Redis.

Redis failures degrade rather than fail: holds become no-ops, rate limiting fails
open, the query embedding cache misses. In every case the database is still the
truth and bookings still cannot collide.
