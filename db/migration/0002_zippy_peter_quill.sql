ALTER TABLE "users" ADD COLUMN "verify_token" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_token" varchar(255);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "refresh_token" varchar(255);--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "remember_token";