CREATE TABLE `last_run_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` text,
	`agent_definition_id` text,
	`credential_set_id` text,
	`model` text,
	`use_worktree` integer,
	`workflow_template_id` text,
	`updated_at` text NOT NULL
);
