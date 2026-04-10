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
CREATE TABLE `task_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`parallel_group_id` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`affected_files` text,
	`depends_on` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`launched_workflow_run_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parallel_group_id`) REFERENCES `parallel_groups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`launched_workflow_run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `parallel_group_id` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `source_proposal_id` text;