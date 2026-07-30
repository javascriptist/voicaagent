-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "table_shape" AS ENUM ('round', 'square', 'rectangle', 'oval');

-- CreateEnum
CREATE TYPE "reservation_status" AS ENUM ('held', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "reservation_source" AS ENUM ('voice', 'web', 'walk_in');

-- CreateEnum
CREATE TYPE "waitlist_status" AS ENUM ('waiting', 'offered', 'converted', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "enquiry_status" AS ENUM ('open', 'in_progress', 'closed');

-- CreateEnum
CREATE TYPE "knowledge_source" AS ENUM ('policy', 'menu', 'faq', 'layout', 'hours');

-- CreateTable
CREATE TABLE "restaurants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "large_party_threshold" INTEGER NOT NULL DEFAULT 8,
    "default_turn_times" JSONB NOT NULL,
    "booking_window_days" INTEGER NOT NULL DEFAULT 90,
    "cancellation_policy" TEXT NOT NULL DEFAULT '',
    "hmac_secret" TEXT NOT NULL,
    "flexibility_minutes" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "floors" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "level" INTEGER NOT NULL,
    "step_free_access" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tables" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "floor_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "min_covers" INTEGER NOT NULL,
    "max_covers" INTEGER NOT NULL,
    "shape" "table_shape" NOT NULL DEFAULT 'rectangle',
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "attributes" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_periods" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "days_of_week" INTEGER[],
    "start_time" VARCHAR(5) NOT NULL,
    "end_time" VARCHAR(5) NOT NULL,
    "slot_interval_minutes" INTEGER NOT NULL DEFAULT 15,
    "last_seating_offset_minutes" INTEGER NOT NULL DEFAULT -60,
    "turn_time_overrides" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "closures" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "table_blocks" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "table_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guests" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "standing_accessibility_needs" JSONB NOT NULL DEFAULT '[]',
    "visit_count" INTEGER NOT NULL DEFAULT 0,
    "no_show_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "table_ids" UUID[],
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "party_size" INTEGER NOT NULL,
    "status" "reservation_status" NOT NULL DEFAULT 'held',
    "source" "reservation_source" NOT NULL,
    "accessibility" JSONB NOT NULL DEFAULT '[]',
    "seating_preferences" JSONB NOT NULL DEFAULT '[]',
    "allergies_verbatim" TEXT,
    "occasion" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "idempotency_key" TEXT,
    "call_id" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_tables" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "table_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "reservation_status" NOT NULL,

    CONSTRAINT "reservation_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waitlist" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "guest_id" UUID NOT NULL,
    "date" VARCHAR(10) NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "window_end" TIMESTAMPTZ(6) NOT NULL,
    "party_size" INTEGER NOT NULL,
    "status" "waitlist_status" NOT NULL DEFAULT 'waiting',
    "accessibility" JSONB NOT NULL DEFAULT '[]',
    "seating_preferences" JSONB NOT NULL DEFAULT '[]',
    "idempotency_key" TEXT,
    "call_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "waitlist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enquiries" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "guest_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "enquiry_status" NOT NULL DEFAULT 'open',
    "idempotency_key" TEXT,
    "call_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "enquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_logs" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "call_id" TEXT NOT NULL,
    "caller_number" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "outcome" TEXT,
    "tool_calls" JSONB NOT NULL DEFAULT '[]',
    "recording_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "call_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "source" "knowledge_source" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "is_generated" BOOLEAN NOT NULL DEFAULT false,
    "generation_key" TEXT,
    "embed_status" TEXT NOT NULL DEFAULT 'pending',
    "embed_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" UUID NOT NULL,
    "restaurant_id" UUID NOT NULL,
    "document_id" UUID,
    "source" "knowledge_source" NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),
    "token_count" INTEGER NOT NULL,
    "chunk_index" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurants_slug_key" ON "restaurants"("slug");

-- CreateIndex
CREATE INDEX "admin_users_restaurant_id_idx" ON "admin_users"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_restaurant_id_email_key" ON "admin_users"("restaurant_id", "email");

-- CreateIndex
CREATE INDEX "floors_restaurant_id_idx" ON "floors"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "floors_restaurant_id_name_key" ON "floors"("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "tables_restaurant_id_idx" ON "tables"("restaurant_id");

-- CreateIndex
CREATE INDEX "tables_floor_id_idx" ON "tables"("floor_id");

-- CreateIndex
CREATE UNIQUE INDEX "tables_restaurant_id_label_key" ON "tables"("restaurant_id", "label");

-- CreateIndex
CREATE INDEX "service_periods_restaurant_id_idx" ON "service_periods"("restaurant_id");

-- CreateIndex
CREATE INDEX "closures_restaurant_id_starts_at_ends_at_idx" ON "closures"("restaurant_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "table_blocks_restaurant_id_starts_at_ends_at_idx" ON "table_blocks"("restaurant_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "table_blocks_table_id_starts_at_ends_at_idx" ON "table_blocks"("table_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "guests_restaurant_id_idx" ON "guests"("restaurant_id");

-- CreateIndex
CREATE UNIQUE INDEX "guests_restaurant_id_phone_key" ON "guests"("restaurant_id", "phone");

-- CreateIndex
CREATE INDEX "reservations_restaurant_id_starts_at_idx" ON "reservations"("restaurant_id", "starts_at");

-- CreateIndex
CREATE INDEX "reservations_restaurant_id_status_starts_at_idx" ON "reservations"("restaurant_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "reservations_guest_id_idx" ON "reservations"("guest_id");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_restaurant_id_idempotency_key_key" ON "reservations"("restaurant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "reservation_tables_table_id_starts_at_ends_at_idx" ON "reservation_tables"("table_id", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "reservation_tables_restaurant_id_starts_at_idx" ON "reservation_tables"("restaurant_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservation_tables_reservation_id_table_id_key" ON "reservation_tables"("reservation_id", "table_id");

-- CreateIndex
CREATE INDEX "waitlist_restaurant_id_date_status_idx" ON "waitlist"("restaurant_id", "date", "status");

-- CreateIndex
CREATE UNIQUE INDEX "waitlist_restaurant_id_idempotency_key_key" ON "waitlist"("restaurant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "enquiries_restaurant_id_status_created_at_idx" ON "enquiries"("restaurant_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "enquiries_restaurant_id_idempotency_key_key" ON "enquiries"("restaurant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "call_logs_restaurant_id_started_at_idx" ON "call_logs"("restaurant_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "call_logs_restaurant_id_call_id_key" ON "call_logs"("restaurant_id", "call_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_restaurant_id_source_idx" ON "knowledge_documents"("restaurant_id", "source");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_restaurant_id_generation_key_key" ON "knowledge_documents"("restaurant_id", "generation_key");

-- CreateIndex
CREATE INDEX "knowledge_chunks_restaurant_id_idx" ON "knowledge_chunks"("restaurant_id");

-- CreateIndex
CREATE INDEX "knowledge_chunks_document_id_idx" ON "knowledge_chunks"("document_id");

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "floors" ADD CONSTRAINT "floors_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tables" ADD CONSTRAINT "tables_floor_id_fkey" FOREIGN KEY ("floor_id") REFERENCES "floors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_periods" ADD CONSTRAINT "service_periods_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "closures" ADD CONSTRAINT "closures_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_blocks" ADD CONSTRAINT "table_blocks_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_blocks" ADD CONSTRAINT "table_blocks_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_tables" ADD CONSTRAINT "reservation_tables_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enquiries" ADD CONSTRAINT "enquiries_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_logs" ADD CONSTRAINT "call_logs_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

