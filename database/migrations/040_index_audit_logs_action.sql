-- Index the audit-log lookup that runs on every mutating request.
--
-- getAdminPlatformSettings() is called by the platform-status preHandler in
-- app.ts for every POST/PUT/PATCH/DELETE. It needs exactly one row: the most
-- recent 'admin.platform_settings.updated'.
--
-- It was getting that row by loading the ENTIRE audit log into memory via
-- db.read() and sorting in JavaScript. Measured on the deployed test API, a
-- signup POST took 146 seconds while GET /health took 0.08s.
--
-- The query is now targeted, and this makes it O(1) rather than a full scan
-- that grows with every audited action the platform ever takes.
create index if not exists idx_audit_logs_action_created
  on payments_audit_logs(action, created_at desc);

-- The admin audit view pages by created_at with no action filter, so it needs
-- its own ordering index rather than reusing the composite above.
create index if not exists idx_audit_logs_created
  on payments_audit_logs(created_at desc);
