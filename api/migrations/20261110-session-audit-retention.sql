-- Apply to the shared SPA/Admin database before deploying session retention.
-- Skip this migration if the same ALTER was already applied manually.
ALTER TABLE `user_sessions`
    ADD COLUMN `ended_at` BIGINT UNSIGNED NULL DEFAULT NULL
        COMMENT 'Session end time: Unix epoch milliseconds',
    ADD COLUMN `end_reason`
        ENUM('logout', 'expired', 'revoked', 'replaced')
        NULL DEFAULT NULL
        COMMENT 'Reason the session ended',
    ADD INDEX `idx_user_sessions_ended_expires` (`ended_at`, `expires_at`),
    ADD INDEX `idx_user_sessions_started_at` (`started_at`);
