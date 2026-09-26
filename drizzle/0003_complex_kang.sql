CREATE TABLE `manager_agents` (
	`manager_id` text NOT NULL,
	`agent_id` text NOT NULL,
	PRIMARY KEY(`manager_id`, `agent_id`),
	FOREIGN KEY (`manager_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_manager_agents_agent` ON `manager_agents` (`agent_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `manager_scope` text DEFAULT 'assigned' NOT NULL;
--> statement-breakpoint
UPDATE users SET manager_scope='global' WHERE id='manager' AND role='manager';
--> statement-breakpoint
INSERT OR IGNORE INTO manager_agents(manager_id,agent_id)
SELECT m.id,a.id FROM users m CROSS JOIN users a
WHERE m.role='manager' AND m.manager_scope='assigned' AND m.active=1
  AND a.role='agent' AND a.active=1;
