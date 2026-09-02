-- Population engine website stats table.
-- Stores the current active shell count so FluxCP can display it on the homepage.
-- The map-server updates this row via INSERT ... ON DUPLICATE KEY UPDATE on each
-- autosummon tick (only when the count changes) and resets to 0 on engine stop.

CREATE TABLE IF NOT EXISTS `cp_population_stats` (
  `id`           INT UNSIGNED NOT NULL DEFAULT 1,
  `active_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_updated` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `cp_population_stats` (`id`, `active_count`) VALUES (1, 0);
