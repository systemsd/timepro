import { schema, type DB } from '@timepro/db';

/**
 * Append a row to the generic `audit_logs` table (the designated audit trail).
 * Call inside the same `withTenantDb` transaction as the mutation so the log
 * and the change commit together.
 */
export async function recordAudit(
  tx: DB,
  entry: {
    organizationId: string;
    actorUserId?: string | null; // null for system/automated actions
    actorType?: 'user' | 'system' | 'agent'; // default 'user'
    action: string; // e.g. 'time_entry.update'
    targetType: string; // e.g. 'time_entry'
    targetId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(schema.auditLogs).values({
    organizationId: entry.organizationId,
    actorUserId: entry.actorUserId ?? null,
    actorType: entry.actorType ?? 'user',
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ?? {},
  });
}
