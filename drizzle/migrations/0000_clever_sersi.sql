CREATE TYPE "public"."status" AS ENUM('creating', 'starting', 'running', 'stopped', 'error', 'migrating');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('whatsmeow', 'baileys', 'wawebjs', 'waba');--> statement-breakpoint
CREATE TABLE "instance_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"key" varchar(255) NOT NULL,
	"value" "bytea" NOT NULL,
	CONSTRAINT "instance_key_idx" UNIQUE("instance_id","key")
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" serial PRIMARY KEY NOT NULL,
	"node_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"name" varchar(256),
	"phone_number" varchar(20) NOT NULL,
	"provider" "provider" NOT NULL,
	"webhook_url" text,
	"status" "status" DEFAULT 'creating' NOT NULL,
	"cpu_limit" varchar(10) DEFAULT '0.5',
	"memory_limit" varchar(10) DEFAULT '512m',
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" varchar(256) NOT NULL,
	"docker_host" text NOT NULL,
	"public_host" text NOT NULL,
	CONSTRAINT "nodes_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(256) NOT NULL,
	"api_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
ALTER TABLE "instance_state" ADD CONSTRAINT "instance_state_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_phone_idx" ON "instances" USING btree ("user_id","phone_number");