CREATE TABLE `agent_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`command_template` text NOT NULL,
	`docker_image` text,
	`description` text,
	`supports_streaming` integer DEFAULT true NOT NULL,
	`supports_continue` integer DEFAULT true NOT NULL,
	`supports_intervention` integer DEFAULT true NOT NULL,
	`output_format` text DEFAULT 'acp' NOT NULL,
	`is_built_in` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credential_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`credential_set_id` text,
	`credential_entry_id` text,
	`workflow_run_id` text,
	`details` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_credential_audit_set` ON `credential_audit_log` (`credential_set_id`);--> statement-breakpoint
CREATE INDEX `idx_credential_audit_run` ON `credential_audit_log` (`workflow_run_id`);--> statement-breakpoint
CREATE TABLE `credential_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`credential_set_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`mount_path` text,
	`command` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`credential_set_id`) REFERENCES `credential_sets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_credential_entries_set` ON `credential_entries` (`credential_set_id`);--> statement-breakpoint
CREATE TABLE `credential_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`project_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_credential_sets_project` ON `credential_sets` (`project_id`);--> statement-breakpoint
CREATE TABLE `git_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`parallel_group_id` text,
	`phase` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_git_op_run_type` ON `git_operations` (`workflow_run_id`,`type`);--> statement-breakpoint
CREATE TABLE `hook_resumes` (
	`id` text PRIMARY KEY NOT NULL,
	`hook_token` text NOT NULL,
	`action` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hook_resumes_hook_token_unique` ON `hook_resumes` (`hook_token`);--> statement-breakpoint
CREATE TABLE `last_run_config` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`project_id` text,
	`agent_definition_id` text,
	`credential_set_id` text,
	`workflow_template_id` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `parallel_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`source_workflow_run_id` text NOT NULL,
	`name` text,
	`description` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`source_workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_parallel_groups_source_run` ON `parallel_groups` (`source_workflow_run_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`git_url` text,
	`local_path` text NOT NULL,
	`description` text,
	`default_credential_set_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`default_credential_set_id`) REFERENCES `credential_sets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`parallel_group_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`affected_files` text,
	`depends_on` text,
	`workflow_template_override` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`launched_workflow_run_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parallel_group_id`) REFERENCES `parallel_groups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_template_override`) REFERENCES `workflow_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`launched_workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_proposal_run_stage_title` ON `proposals` (`workflow_run_id`,`stage_name`,`title`);--> statement-breakpoint
CREATE INDEX `idx_proposals_run` ON `proposals` (`workflow_run_id`);--> statement-breakpoint
CREATE INDEX `idx_proposals_parallel_group` ON `proposals` (`parallel_group_id`);--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`file_path` text,
	`line_number` integer,
	`side` text,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_comments_review` ON `review_comments` (`review_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`type` text DEFAULT 'stage' NOT NULL,
	`status` text DEFAULT 'pending_review' NOT NULL,
	`ai_summary` text,
	`diff_snapshot` text,
	`plan_markdown` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_review_run_stage_round_type` ON `reviews` (`workflow_run_id`,`stage_name`,`round`,`type`);--> statement-breakpoint
CREATE INDEX `idx_reviews_run` ON `reviews` (`workflow_run_id`);--> statement-breakpoint
CREATE TABLE `run_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`stage_name` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`session_boundary` integer DEFAULT false NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`is_intervention` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_run_messages_run` ON `run_messages` (`workflow_run_id`);--> statement-breakpoint
CREATE INDEX `idx_run_messages_run_stage` ON `run_messages` (`workflow_run_id`,`stage_name`);--> statement-breakpoint
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
	`agent_definition_id` text NOT NULL,
	`parent_run_id` text,
	`parallel_group_id` text,
	`description` text,
	`title` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_stage` text,
	`sandbox_id` text,
	`worktree_path` text,
	`branch` text,
	`acp_session_id` text,
	`credential_set_id` text,
	`base_branch` text,
	`target_branch` text,
	`model` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`workflow_template_id`) REFERENCES `workflow_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_definition_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parallel_group_id`) REFERENCES `parallel_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credential_set_id`) REFERENCES `credential_sets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_status` ON `workflow_runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_project` ON `workflow_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_parent` ON `workflow_runs` (`parent_run_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_parallel_group` ON `workflow_runs` (`parallel_group_id`);--> statement-breakpoint
CREATE TABLE `workflow_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`stages` text NOT NULL,
	`is_built_in` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
