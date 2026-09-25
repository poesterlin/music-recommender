CREATE TABLE IF NOT EXISTS "api_key" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"scope" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_key_scope_check" CHECK ("scope" IN ('worker', 'playback'))
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'api_key_user_id_fkey'
	) THEN
		ALTER TABLE "api_key"
			ADD CONSTRAINT "api_key_user_id_fkey"
			FOREIGN KEY ("user_id") REFERENCES "user"("id")
			ON DELETE CASCADE ON UPDATE CASCADE;
	END IF;
END
$$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apiKeyUserIdx" ON "api_key" ("user_id");
