CREATE TABLE IF NOT EXISTS "billing"."billing_event" (aggregate TEXT NOT NULL, account TEXT NOT NULL, seq INTEGER NOT NULL, command_id TEXT NOT NULL, at BIGINT NOT NULL, event TEXT NOT NULL, PRIMARY KEY (aggregate, account, seq));
CREATE INDEX IF NOT EXISTS "billing_event_command" ON "billing"."billing_event" (aggregate, account, command_id);
CREATE TABLE IF NOT EXISTS "billing"."billing_receipt" (aggregate TEXT NOT NULL, account TEXT NOT NULL, command_id TEXT NOT NULL, version INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY (aggregate, account, command_id));
CREATE TABLE IF NOT EXISTS "billing"."billing_state" (aggregate TEXT NOT NULL, account TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY (aggregate, account));
CREATE TABLE IF NOT EXISTS "billing"."billing_outbox" (seq BIGSERIAL PRIMARY KEY, aggregate TEXT NOT NULL, account TEXT NOT NULL, event_seq INTEGER NOT NULL, delivery TEXT NOT NULL, delivered_at BIGINT);
CREATE INDEX IF NOT EXISTS "billing_outbox_pending" ON "billing"."billing_outbox" (delivered_at, seq);
CREATE TABLE IF NOT EXISTS "billing"."billing_schedule" (aggregate TEXT NOT NULL, account TEXT NOT NULL, command_id TEXT NOT NULL, due_at BIGINT NOT NULL, command TEXT NOT NULL, delivered_at BIGINT, PRIMARY KEY (aggregate, account, command_id));
CREATE INDEX IF NOT EXISTS "billing_schedule_due" ON "billing"."billing_schedule" (delivered_at, due_at);
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_billing_read" (account TEXT PRIMARY KEY, tier TEXT NOT NULL, status TEXT NOT NULL, standing TEXT NOT NULL, period_start BIGINT NOT NULL, period_end BIGINT NOT NULL, cancel_at_period_end INTEGER NOT NULL, credits INTEGER NOT NULL, prepaid_credits INTEGER NOT NULL, dunning_attempts INTEGER NOT NULL, proration TEXT, proration_invoice TEXT, currency TEXT, features TEXT NOT NULL, entities TEXT);
CREATE INDEX IF NOT EXISTS "billing_rm_billing_read_standing" ON "billing"."billing_rm_billing_read" (standing, tier);
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_backfill" (consumer TEXT PRIMARY KEY, generation INTEGER NOT NULL, plan TEXT NOT NULL, completed_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_view_outbox" (seq BIGSERIAL PRIMARY KEY, view TEXT NOT NULL, key TEXT NOT NULL, entry_seq INTEGER NOT NULL, delivery TEXT NOT NULL, delivered_at BIGINT);
CREATE INDEX IF NOT EXISTS "billing_rm_view_outbox_pending" ON "billing"."billing_rm_view_outbox" (view, key, delivered_at, seq);
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_view_state" (
      view TEXT NOT NULL,
      key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      version INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      checkpoints TEXT NOT NULL,
      state TEXT,
      PRIMARY KEY (view, key)
    );
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_view_entry" (
      view TEXT NOT NULL,
      key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0,
      event TEXT NOT NULL,
      envelope TEXT NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (view, key, seq)
    );
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_view_input" (
      view TEXT NOT NULL,
      key TEXT NOT NULL,
      source TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      PRIMARY KEY (view, key, source, source_seq)
    );
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_projection_input" (
      projection TEXT NOT NULL,
      key TEXT NOT NULL,
      source TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      position INTEGER NOT NULL,
      delivery TEXT NOT NULL,
      accepted_at BIGINT NOT NULL,
      processed_at BIGINT,
      PRIMARY KEY (projection, key, source, source_seq)
    );
CREATE INDEX IF NOT EXISTS "billing_rm_projection_pending"
      ON "billing"."billing_rm_projection_input" (projection, key, processed_at, position);
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_projection_cursor" (
      projection TEXT NOT NULL,
      key TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (projection, key)
    );
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_policy_seen" (
      policy TEXT NOT NULL,
      key TEXT NOT NULL,
      source TEXT NOT NULL,
      source_seq INTEGER NOT NULL,
      PRIMARY KEY (policy, key, source, source_seq)
    );
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_stream_meta" (
      stream TEXT NOT NULL,
      key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      checkpoints TEXT NOT NULL,
      origin_a INTEGER NOT NULL,
      origin_b INTEGER NOT NULL,
      PRIMARY KEY (stream, key)
    );
CREATE TABLE IF NOT EXISTS "billing"."billing_rm_stream_entry" (
      stream TEXT NOT NULL,
      key TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event TEXT NOT NULL,
      envelope TEXT NOT NULL,
      PRIMARY KEY (stream, key, seq)
    );
