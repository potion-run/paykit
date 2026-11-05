CREATE TABLE IF NOT EXISTS "billing_rm_view_outbox" (seq INTEGER PRIMARY KEY AUTOINCREMENT, view TEXT NOT NULL, key TEXT NOT NULL, entry_seq INTEGER NOT NULL, delivery TEXT NOT NULL, delivered_at INTEGER);
CREATE INDEX IF NOT EXISTS "billing_rm_view_outbox_pending" ON "billing_rm_view_outbox" (view, key, delivered_at, seq);
