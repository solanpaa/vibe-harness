CREATE TABLE `credential_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`credential_set_id` text,
	`credential_entry_id` text,
	`task_id` text,
	`details` text,
	`created_at` text NOT NULL
);
