ALTER TABLE "billing_rm_view_entry" ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS "billing_rm_backfill" (consumer TEXT PRIMARY KEY, generation INTEGER NOT NULL, plan TEXT NOT NULL, completed_at INTEGER NOT NULL);
