CREATE TABLE IF NOT EXISTS "billing_outbox_next" (seq INTEGER PRIMARY KEY AUTOINCREMENT, aggregate TEXT NOT NULL, account TEXT NOT NULL, event_seq INTEGER NOT NULL, delivery TEXT NOT NULL, delivered_at INTEGER);
INSERT INTO "billing_outbox_next" (aggregate, account, event_seq, delivery, delivered_at)
       SELECT aggregate, account, event_seq, delivery, delivered_at FROM "billing_outbox" ORDER BY seq;
DROP TABLE "billing_outbox";
ALTER TABLE "billing_outbox_next" RENAME TO "billing_outbox";
CREATE INDEX IF NOT EXISTS "billing_outbox_pending" ON "billing_outbox" (delivered_at, seq);
