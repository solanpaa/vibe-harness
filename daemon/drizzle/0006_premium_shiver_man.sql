ALTER TABLE `projects` ADD `sandbox_memory` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `sandbox_cpus` integer;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `sandbox_memory` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `sandbox_cpus` integer;