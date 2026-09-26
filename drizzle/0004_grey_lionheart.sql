CREATE TABLE `partner_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`warehouse_id` text NOT NULL,
	`cui_key` text NOT NULL,
	`status` text DEFAULT 'requested' NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`confirmed_at` text,
	`confirmed_by` text,
	`customer_id` text,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_partner_requests_agent_created` ON `partner_requests` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_partner_requests_status_created` ON `partner_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_partner_requests_cui` ON `partner_requests` (`cui_key`);