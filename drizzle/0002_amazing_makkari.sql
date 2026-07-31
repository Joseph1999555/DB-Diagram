CREATE TABLE `cursor_presence` (
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`x` real NOT NULL,
	`y` real NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`project_id`, `user_id`, `session_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "cursor_presence_session_length_check" CHECK(length("cursor_presence"."session_id") between 8 and 64),
	CONSTRAINT "cursor_presence_coordinates_check" CHECK("cursor_presence"."x" between -1000000 and 1000000 and "cursor_presence"."y" between -1000000 and 1000000)
);
--> statement-breakpoint
CREATE INDEX `cursor_presence_project_updated_idx` ON `cursor_presence` (`project_id`,`updated_at`);