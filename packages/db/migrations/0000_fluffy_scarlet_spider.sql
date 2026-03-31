CREATE TYPE "public"."leaderboard_period" AS ENUM('daily', 'weekly', 'monthly', 'alltime');--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"prefix" varchar(12) NOT NULL,
	"name" varchar(64) NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "daily_aggregates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"total_input" bigint DEFAULT 0 NOT NULL,
	"total_output" bigint DEFAULT 0 NOT NULL,
	"total_cache_read" bigint DEFAULT 0 NOT NULL,
	"total_cache_write" bigint DEFAULT 0 NOT NULL,
	"total_reasoning" bigint DEFAULT 0 NOT NULL,
	"total_cost" numeric(12, 6) DEFAULT '0' NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"clients_used" text[] DEFAULT '{}' NOT NULL,
	"models_used" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "daily_agg_user_date_uniq" UNIQUE("user_id","date")
);
--> statement-breakpoint
CREATE TABLE "rankings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leaderboard_id" varchar(255) NOT NULL,
	"user_id" uuid NOT NULL,
	"period" "leaderboard_period" NOT NULL,
	"period_start" date NOT NULL,
	"rank" integer NOT NULL,
	"total_tokens" bigint NOT NULL,
	"total_cost" numeric(12, 4) NOT NULL,
	"composite_score" numeric(12, 4) NOT NULL,
	CONSTRAINT "rankings_uniq" UNIQUE("leaderboard_id","user_id","period","period_start")
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client" varchar(32) NOT NULL,
	"model" varchar(128) NOT NULL,
	"session_hash" varchar(64) NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_tokens" bigint NOT NULL,
	"reasoning_tokens" bigint NOT NULL,
	"cost_usd" numeric(12, 6) NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_records_session_hash_unique" UNIQUE("session_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_id" varchar(255) NOT NULL,
	"username" varchar(64) NOT NULL,
	"avatar_url" text,
	"email" varchar(255),
	"total_tokens" bigint DEFAULT 0 NOT NULL,
	"total_cost" numeric(12, 4) DEFAULT '0' NOT NULL,
	"current_streak" integer DEFAULT 0 NOT NULL,
	"longest_streak" integer DEFAULT 0 NOT NULL,
	"privacy_mode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_id_unique" UNIQUE("clerk_id"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_aggregates" ADD CONSTRAINT "daily_aggregates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rankings" ADD CONSTRAINT "rankings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "daily_agg_user_id_idx" ON "daily_aggregates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "daily_agg_date_idx" ON "daily_aggregates" USING btree ("date");--> statement-breakpoint
CREATE INDEX "rankings_leaderboard_period_idx" ON "rankings" USING btree ("leaderboard_id","period","rank");--> statement-breakpoint
CREATE INDEX "usage_records_user_id_idx" ON "usage_records" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "usage_records_timestamp_idx" ON "usage_records" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "usage_records_user_timestamp_idx" ON "usage_records" USING btree ("user_id","timestamp");