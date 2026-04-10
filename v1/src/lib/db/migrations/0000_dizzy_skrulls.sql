CREATE TABLE `agent_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`command_template` text NOT NULL,
	`docker_image` text,
	`description` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credential_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_set_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`credential_set_id`) REFERENCES `credential_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `credential_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`project_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`git_url` text,
	`local_path` text NOT NULL,
	`description` text,
	`default_credential_set_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`file_path` text NOT NULL,
	`line_number` integer,
	`side` text,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text,
	`task_id` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`ai_summary` text,
	`diff_snapshot` text,
	`plan_markdown` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workflow_run_id` text,
	`stage_name` text,
	`agent_definition_id` text NOT NULL,
	`credential_set_id` text,
	`sandbox_id` text,
	`origin_task_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`prompt` text NOT NULL,
	`model` text,
	`use_worktree` integer DEFAULT 1 NOT NULL,
	`output` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_definition_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_set_id`) REFERENCES `credential_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_template_id` text NOT NULL,
	`project_id` text NOT NULL,
	`task_description` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_stage` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workflow_template_id`) REFERENCES `workflow_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workflow_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`stages` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
