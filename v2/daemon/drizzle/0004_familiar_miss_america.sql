CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `gh_account` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `gh_account` text;