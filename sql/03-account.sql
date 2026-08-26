-- A ready-to-use login for a fresh install.
--
-- Without this the first thing a new player meets is rAthena's registration
-- convention: type your username with an _M or _F suffix and the account is
-- created implicitly. That is fine once you know it and baffling when you do
-- not, and nothing on the login screen says so.
--
-- group_id 99 is the Admin group from conf/groups.yml. This is a single-player
-- server on loopback that the player also operates, so @commands work out of
-- the box. To play without them: UPDATE login SET group_id = 0 WHERE userid =
-- 'ragnarok';
--
-- Passwords are plaintext because rAthena's use_MD5_passwords defaults to no
-- and we do not override it -- the same as the s1/p1 row the schema ships.
--
-- No character is created: the player picks their own class and appearance.
--
-- Guarded with NOT EXISTS rather than INSERT IGNORE: rAthena indexes userid
-- with a plain KEY, not a UNIQUE one, so IGNORE has no conflict to suppress and
-- happily inserts a second 'ragnarok' every startup.
INSERT INTO `login` (`userid`, `user_pass`, `sex`, `email`, `group_id`)
SELECT 'ragnarok', 'ragnarok', 'M', 'ragnarok@localhost', 99 FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM `login` WHERE `userid` = 'ragnarok');
