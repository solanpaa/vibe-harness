CREATE TABLE `comparison_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`prompt` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'running' NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`is_intervention` integer DEFAULT 0 NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `execution_mode` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `comparison_group_id` text REFERENCES comparison_groups(id);