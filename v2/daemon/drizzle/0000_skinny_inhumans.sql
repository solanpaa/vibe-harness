CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`git_url` text,
	`local_path` text NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stage_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`prompt` text,
	`fresh_session` integer DEFAULT false NOT NULL,
	`model` text,
	`started_at` text,
	`completed_at` text,
	`failure_reason` text,
	`usage_stats` text,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_stage_execution_run_stage_round` ON `stage_executions` (`workflow_run_id`,`stage_name`,`round`);--> statement-breakpoint
CREATE INDEX `idx_stage_executions_run` ON `stage_executions` (`workflow_run_id`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_template_id` text NOT NULL,
	`project_id` text NOT NULL,
	`description` text,
	`title` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_stage` text,
	`sandbox_id` text,
	`worktree_path` text,
	`branch` text,
	`model` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workflow_template_id`) REFERENCES `workflow_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_status` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_project` ON `workflow_runs` (`project_id`);--> statement-breakpoint
CREATE TABLE `workflow_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`stages` text NOT NULL,
	`is_built_in` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
