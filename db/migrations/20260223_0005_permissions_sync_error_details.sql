ALTER TABLE msgraph_drive_items
ADD COLUMN IF NOT EXISTS permissions_last_error_details jsonb;

CREATE INDEX IF NOT EXISTS idx_drive_items_permissions_error_at
ON msgraph_drive_items (permissions_last_error_at DESC)
WHERE deleted_at IS NULL AND permissions_last_error_at IS NOT NULL;
