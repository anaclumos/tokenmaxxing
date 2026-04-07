CREATE TYPE "public"."budget_alert_period" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TABLE "budget_alert_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actual_cost" numeric(12, 6) NOT NULL,
	"threshold_cost" numeric(12, 6) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" varchar(255) NOT NULL,
	"user_id" uuid,
	"period" "budget_alert_period" NOT NULL,
	"threshold_usd" numeric(12, 6) NOT NULL,
	"webhook_url" text,
	"email_notify" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "budget_alert_events" ADD CONSTRAINT "budget_alert_events_alert_id_budget_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."budget_alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_alert_events_alert_id_idx" ON "budget_alert_events" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "budget_alert_events_triggered_at_idx" ON "budget_alert_events" USING btree ("triggered_at");--> statement-breakpoint
CREATE INDEX "budget_alerts_org_id_idx" ON "budget_alerts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "budget_alerts_user_id_idx" ON "budget_alerts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "budget_alerts_org_period_idx" ON "budget_alerts" USING btree ("org_id","period");