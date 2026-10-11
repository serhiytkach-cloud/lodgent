CREATE TABLE "agent_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"contact_email" text,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"rate_limit_per_minute" integer,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_clients_key_hash_unique" UNIQUE("key_hash")
);
