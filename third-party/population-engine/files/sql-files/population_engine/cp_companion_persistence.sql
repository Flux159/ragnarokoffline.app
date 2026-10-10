-- Companion persistence (population engine): one row per recruited companion, keyed by the
-- real player's account. It stores the deterministic spawn inputs (class, appearance,
-- equipment, stats) and the player's choices for it (stance, duty, heal thresholds, skill
-- selection, homunculus) so a companion keeps its identity across restarts.
--
-- This is the only copy of the schema: the supervisor (stack/src/cmds.rs,
-- ensure_companion_table) includes this file and runs it after the database comes up and
-- before the game servers start. A column added later goes here AND in COMPANION_COLUMNS
-- there, which is what upgrades a table created before it.
CREATE TABLE IF NOT EXISTS `cp_companion_persistence` (
  `id`               INT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `owner_account_id` INT UNSIGNED  NOT NULL,
  `owner_char_id`    INT UNSIGNED  NOT NULL DEFAULT 0,  -- the owning CHARACTER (v10); 0 = saved before companions were per character, claimed at that account's next login
  `shell_index`      INT UNSIGNED  NOT NULL,          -- spawn index_ (char/account id - BASE) -> identity survives restart
  `name`             VARCHAR(24)   NOT NULL DEFAULT '',-- persistent display name (v2)
  `job_id`           SMALLINT      NOT NULL DEFAULT 0,
  `sex`              TINYINT       NOT NULL DEFAULT 0, -- rAthena e_sex: 0 SEX_FEMALE, 1 SEX_MALE
  `hair_style`       TINYINT       NOT NULL DEFAULT 1,
  `hair_color`       SMALLINT      NOT NULL DEFAULT 0,
  `cloth_color`      SMALLINT      NOT NULL DEFAULT 0,
  `garment_nameid`   INT UNSIGNED  NOT NULL DEFAULT 0,
  `option_`          INT UNSIGNED  NOT NULL DEFAULT 0,
  `weapon_nameid`    INT UNSIGNED  NOT NULL DEFAULT 0,
  `shield_nameid`    INT UNSIGNED  NOT NULL DEFAULT 0,
  `head_top_nameid`  INT UNSIGNED  NOT NULL DEFAULT 0,
  `head_mid_nameid`  INT UNSIGNED  NOT NULL DEFAULT 0,
  `head_bottom_nameid` INT UNSIGNED NOT NULL DEFAULT 0,
  `armor_nameid`     INT UNSIGNED  NOT NULL DEFAULT 0,
  `shoes_nameid`     INT UNSIGNED  NOT NULL DEFAULT 0,
  `acc_l_nameid`     INT UNSIGNED  NOT NULL DEFAULT 0, -- accessory left (Goal 2, v3)
  `acc_r_nameid`     INT UNSIGNED  NOT NULL DEFAULT 0, -- accessory right (Goal 2, v3)
  `costume_top_nameid`    INT UNSIGNED NOT NULL DEFAULT 0, -- costume headgear (v4)
  `costume_mid_nameid`    INT UNSIGNED NOT NULL DEFAULT 0,
  `costume_low_nameid`    INT UNSIGNED NOT NULL DEFAULT 0,
  `costume_garment_nameid` INT UNSIGNED NOT NULL DEFAULT 0,
  `shadow_armor_nameid`   INT UNSIGNED NOT NULL DEFAULT 0, -- shadow gear (v4)
  `shadow_weapon_nameid`  INT UNSIGNED NOT NULL DEFAULT 0,
  `shadow_shield_nameid`  INT UNSIGNED NOT NULL DEFAULT 0,
  `shadow_shoes_nameid`   INT UNSIGNED NOT NULL DEFAULT 0,
  `shadow_acc_l_nameid`   INT UNSIGNED NOT NULL DEFAULT 0,
  `shadow_acc_r_nameid`   INT UNSIGNED NOT NULL DEFAULT 0,
  `base_level`       SMALLINT      NOT NULL DEFAULT 99,
  `job_level`        SMALLINT      NOT NULL DEFAULT 70,
  `str_`             SMALLINT      NOT NULL DEFAULT 100,
  `agi_`             SMALLINT      NOT NULL DEFAULT 100,
  `vit_`             SMALLINT      NOT NULL DEFAULT 100,
  `intl_`            SMALLINT      NOT NULL DEFAULT 100,
  `dex_`             SMALLINT      NOT NULL DEFAULT 100,
  `luk_`             SMALLINT      NOT NULL DEFAULT 100,
  `pow_`             SMALLINT      NOT NULL DEFAULT 0, -- 4th-job traits (growth, v5)
  `sta_`             SMALLINT      NOT NULL DEFAULT 0,
  `wis_`             SMALLINT      NOT NULL DEFAULT 0,
  `spl_`             SMALLINT      NOT NULL DEFAULT 0,
  `con_`             SMALLINT      NOT NULL DEFAULT 0,
  `crt_`             SMALLINT      NOT NULL DEFAULT 0,
  `mode`             TINYINT       NOT NULL DEFAULT 1, -- companion stance: 0 passive, 1 defensive, 2 attack (v6)
  `duty`             TINYINT       NOT NULL DEFAULT 0, -- role (PopulationRoleType): 0 none, 1 tank, 2 support, 3 attacker (v6)
  `heal_at`          TINYINT       NOT NULL DEFAULT 75, -- support heal threshold HP% (v6)
  `emergency_at`     TINYINT       NOT NULL DEFAULT 35, -- support emergency heal HP% (v6)
  `skill_preset`     TEXT          NULL DEFAULT NULL,   -- chosen skill ids, comma separated (v7); NULL = the class preset list, '' = none chosen
  `hom_enabled`      TINYINT       NULL DEFAULT NULL,   -- the pet's switch (v8); NULL = never chosen, i.e. ON for an alchemist-line companion, 0 = the player turned it off
  `hom_class`        INT           NOT NULL DEFAULT 0,  -- the pet's class id (v8), 0 = not attached yet
  `hom_level`        SMALLINT      NOT NULL DEFAULT 0,  -- the pet's level (v8)
  `hom_exp`          BIGINT        NOT NULL DEFAULT 0,  -- the pet's exp toward the next level (v8)
  `given_mask`       INT UNSIGNED  NOT NULL DEFAULT 0,  -- EQP_* positions worn by gear the OWNER gave (v9); only these come back
  `gear_detail`      TEXT          NULL DEFAULT NULL,   -- every worn piece in full: refine, cards, options (v11); NULL = saved before v11, recalled from the *_nameid columns alone
  `rest_below`       TINYINT       NOT NULL DEFAULT 30, -- sits down between fights below this SP% or HP%, 0 = never (v12)
  `rest_until`       TINYINT       NOT NULL DEFAULT 95, -- stands again once both are back to this % (v12)
  `inventory_detail` TEXT          NULL DEFAULT NULL,   -- the rest of the bag: every unworn stack and the worn ammo, in full (v13); NULL = saved before inventories, recalled with what the spawn gives
  `roam`             TINYINT       NOT NULL DEFAULT 0,  -- 1 = walks the owner's map on its own instead of following (v14)
  `map_id`           SMALLINT      NOT NULL DEFAULT 0, -- mapindex id of owner at recruit (recall target)
  `active`           TINYINT       NOT NULL DEFAULT 1, -- 1 = recalled on login; 0 = released (Goal 3 sets this)
  `favorite`         TINYINT       NOT NULL DEFAULT 0, -- 1 = owner favorited (friend list sort)
  `recruited_at`     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
                 ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_index` (`shell_index`),
  KEY `idx_owner` (`owner_account_id`),
  KEY `idx_owner_char` (`owner_account_id`, `owner_char_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
