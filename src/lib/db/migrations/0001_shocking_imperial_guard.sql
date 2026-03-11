ALTER TABLE `sessions` ADD `model` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `use_worktree` integer DEFAULT 1 NOT NULL;