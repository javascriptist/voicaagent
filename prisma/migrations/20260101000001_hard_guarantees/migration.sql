-- Everything in this migration is load-bearing and cannot be expressed in
-- Prisma schema language.

-- ---------------------------------------------------------------------------
-- 1. No double bookings. Ever.
-- ---------------------------------------------------------------------------
-- This is the actual guarantee. The Redis hold is an optimisation that keeps
-- two concurrent callers from being offered the same table; this constraint is
-- what makes it impossible for both of them to actually get it.
--
-- Half-open range '[)': a booking ending at 20:00 and one starting at 20:00 do
-- not conflict, which is what "the table turns at 20:00" means.
--
-- Only live statuses participate. A cancelled or no-show reservation must not
-- keep holding the table, and completed ones are history.
--
-- Requires btree_gist because we mix an equality operator (=) on a uuid with an
-- overlap operator (&&) on a range in the same constraint.

ALTER TABLE "reservation_tables"
  ADD CONSTRAINT "reservation_tables_no_overlap"
  EXCLUDE USING gist (
    "table_id" WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" IN ('held', 'confirmed', 'seated'));

-- A reservation cannot end before it starts. Cheap, and it stops a bad turn
-- time calculation from silently creating a zero-width range that overlaps
-- nothing and books a table into a black hole.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_ends_after_starts" CHECK ("ends_at" > "starts_at");

ALTER TABLE "reservation_tables"
  ADD CONSTRAINT "reservation_tables_ends_after_starts" CHECK ("ends_at" > "starts_at");

ALTER TABLE "table_blocks"
  ADD CONSTRAINT "table_blocks_ends_after_starts" CHECK ("ends_at" > "starts_at");

ALTER TABLE "closures"
  ADD CONSTRAINT "closures_ends_after_starts" CHECK ("ends_at" > "starts_at");

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_party_size_positive" CHECK ("party_size" > 0);

-- ---------------------------------------------------------------------------
-- 2. Keep reservation_tables in sync with its parent reservation.
-- ---------------------------------------------------------------------------
-- reservation_tables mirrors starts_at / ends_at / status from reservations so
-- the exclusion constraint above has columns to work with. If application code
-- ever updated one without the other, the constraint would be enforcing stale
-- facts. A trigger removes that possibility entirely.

CREATE OR REPLACE FUNCTION sync_reservation_tables() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status"
     OR NEW."starts_at" IS DISTINCT FROM OLD."starts_at"
     OR NEW."ends_at" IS DISTINCT FROM OLD."ends_at"
  THEN
    UPDATE "reservation_tables"
       SET "status"    = NEW."status",
           "starts_at" = NEW."starts_at",
           "ends_at"   = NEW."ends_at"
     WHERE "reservation_id" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservations_sync_tables
  AFTER UPDATE ON "reservations"
  FOR EACH ROW
  EXECUTE FUNCTION sync_reservation_tables();

-- ---------------------------------------------------------------------------
-- 3. Idempotency keys
-- ---------------------------------------------------------------------------
-- Prisma's @@unique([restaurantId, idempotencyKey]) generates a plain unique
-- index, and in Postgres NULLs are distinct, so unkeyed rows do not collide.
-- That is the behaviour we want (web and walk-in writes have no key), so the
-- generated index is left as-is. Documented here so nobody "fixes" it later.

-- ---------------------------------------------------------------------------
-- 4. Vector search
-- ---------------------------------------------------------------------------
-- HNSW over cosine distance. Built after the table exists but while it is
-- empty, which is the cheap direction.
--
-- m / ef_construction are the pgvector defaults; they are a good balance for
-- the few thousand chunks a single restaurant produces. ef_search is set per
-- query in src/knowledge/store.ts.

CREATE INDEX "knowledge_chunks_embedding_hnsw"
  ON "knowledge_chunks"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- The HNSW index alone cannot enforce tenant scoping, and pgvector applies the
-- restaurant_id filter after the index scan. This btree lets the planner choose
-- a plain filtered scan instead when a restaurant has few chunks, which is the
-- common case and is faster than an approximate search over every tenant.
CREATE INDEX "knowledge_chunks_restaurant_id_btree"
  ON "knowledge_chunks" ("restaurant_id");

-- ---------------------------------------------------------------------------
-- 5. Availability read path
-- ---------------------------------------------------------------------------
-- The hot query is "every live reservation for these tables in this window".
CREATE INDEX "reservation_tables_live_window"
  ON "reservation_tables" ("restaurant_id", "starts_at", "ends_at")
  WHERE "status" IN ('held', 'confirmed', 'seated');
