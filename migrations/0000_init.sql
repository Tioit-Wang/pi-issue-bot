CREATE TABLE "actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"intent" text NOT NULL,
	"target" text NOT NULL,
	"external_ref" text,
	"applied_at" timestamp with time zone,
	"reverted_at" timestamp with time zone,
	"revert_kind" text,
	"audit" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_labels" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"label" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "degeneracy_hits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"criterion" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "envelopes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"verdict" jsonb,
	"actions" jsonb,
	"usage" jsonb,
	"valid" boolean DEFAULT false NOT NULL,
	"errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_credentials" (
	"host_id" text PRIMARY KEY NOT NULL,
	"token_enc" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_fingerprints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo" text NOT NULL,
	"fingerprint" text NOT NULL,
	"issue_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_states" (
	"repo" text NOT NULL,
	"issue_number" integer NOT NULL,
	"missing_set_hash" text,
	"first_seen_at" timestamp with time zone,
	"last_human_reply_at" timestamp with time zone,
	"last_nudge_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_states_repo_issue_number_pk" PRIMARY KEY("repo","issue_number")
);
--> statement-breakpoint
CREATE TABLE "metrics_daily" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"repo" text NOT NULL,
	"outcome" text NOT NULL,
	"run_count" integer DEFAULT 0 NOT NULL,
	"p50_ms" integer,
	"p95_ms" integer,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"revert_count" integer DEFAULT 0 NOT NULL,
	"command_cost_usd" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panel_sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"login" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"repo_full_name" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"config" jsonb,
	"config_valid" boolean DEFAULT false NOT NULL,
	"config_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"cursor" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"session_id" text,
	"turn_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"failure_class" text,
	"failure_detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"repo" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_number" integer NOT NULL,
	"head_sha" text,
	"command" text NOT NULL,
	"actor_login" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"container_name" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"delivery_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "usage_costs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"action" text,
	"payload" jsonb NOT NULL,
	"signature_valid" boolean DEFAULT true NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "actions_run_id_idx" ON "actions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "actions_target_idx" ON "actions" USING btree ("target","applied_at");--> statement-breakpoint
CREATE INDEX "actions_applied_at_idx" ON "actions" USING btree ("applied_at");--> statement-breakpoint
CREATE INDEX "actions_revert_kind_idx" ON "actions" USING btree ("revert_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_labels_active_uidx" ON "bot_labels" USING btree ("repo","issue_number","label") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "bot_labels_repo_issue_idx" ON "bot_labels" USING btree ("repo","issue_number");--> statement-breakpoint
CREATE INDEX "degeneracy_hits_run_id_idx" ON "degeneracy_hits" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "envelopes_run_id_uidx" ON "envelopes" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_fingerprints_repo_fp_uidx" ON "issue_fingerprints" USING btree ("repo","fingerprint");--> statement-breakpoint
CREATE INDEX "issue_states_close_scan_idx" ON "issue_states" USING btree ("first_seen_at","last_human_reply_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metrics_daily_day_repo_outcome_uidx" ON "metrics_daily" USING btree ("day","repo","outcome");--> statement-breakpoint
CREATE INDEX "panel_sessions_expires_at_idx" ON "panel_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_id_cursor_uidx" ON "run_events" USING btree ("run_id","cursor");--> statement-breakpoint
CREATE INDEX "run_events_created_at_idx" ON "run_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "runs_task_id_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runs_outcome_started_at_idx" ON "runs" USING btree ("outcome","started_at");--> statement-breakpoint
CREATE INDEX "runs_started_at_idx" ON "runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idempotency_key_uidx" ON "tasks" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "tasks_status_queued_at_idx" ON "tasks" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "tasks_repo_created_at_idx" ON "tasks" USING btree ("repo","created_at");--> statement-breakpoint
CREATE INDEX "tasks_command_idx" ON "tasks" USING btree ("command");--> statement-breakpoint
CREATE INDEX "tasks_target_idx" ON "tasks" USING btree ("repo","target_kind","target_number");--> statement-breakpoint
CREATE INDEX "usage_costs_run_id_idx" ON "usage_costs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_costs_model_created_at_idx" ON "usage_costs" USING btree ("model","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_action_idx" ON "webhook_deliveries" USING btree ("event","action");