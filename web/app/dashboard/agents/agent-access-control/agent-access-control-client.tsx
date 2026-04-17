"use client";

import * as React from "react";
import Link from "next/link";
import { getCsrfFetchHeaders } from "@/app/lib/csrf-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import LocalDateTime from "@/components/local-date-time";
import { getDvColumns, type DvColumns } from "@/app/lib/dv-columns";
import PageHeader from "@/components/page-header";
import MetricGrid from "@/components/metric-grid";
import { MetricCard } from "@/components/metric-card";

const TIMESTAMP_KEYS = new Set(["modifiedon"]);

type SortDirection = "asc" | "desc";

type SortConfig = {
  key: string;
  direction: SortDirection;
};

type DvRow = Record<string, any>;

type ActiveBlock = {
  id: string;
  dv_row_id: string;
  user_id: string;
  user_display_name: string | null;
  user_principal_name: string | null;
  bot_id: string;
  bot_name: string | null;
  block_scope: "agent";
  blocked_by: string;
  system_modified_by: string;
  blocked_at: string;
  block_reason: string | null;
};

type QuarantineAgent = {
  botId: string;
  botName: string;
  lastUpdateTimeUtc: string | null;
  isQuarantined: boolean | null;
  state: string;
  actionLabel: "Block" | "Unblock";
  error: string | null;
};

type QuarantineContext = {
  canView: boolean;
  canAct: boolean;
  needsConsent: boolean;
  hasRequiredScope: boolean;
  roleCheck?: {
    allowed: boolean;
    matchedRoles: string[];
    roleNames: string[];
    checkedAt: string;
    error: string | null;
  };
  agents: QuarantineAgent[];
};

function normalizeValue(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function getSortableValue(value: unknown): number | string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  const asString = String(value).trim();
  const asDate = Date.parse(asString);
  if (!Number.isNaN(asDate)) return asDate;
  return asString.toLowerCase();
}

function getSortIndicator(sortConfig: SortConfig, key: string): string {
  if (sortConfig.key !== key) return "↕";
  return sortConfig.direction === "asc" ? "↑" : "↓";
}

function isUserDeleteFlagAllowed(value: unknown): boolean {
  if (typeof value === "number") return value === 4;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "4" || normalized === "allowed";
  }
  return false;
}

function findDvRow(rows: DvRow[], agentName: string, userName: string, cols: DvColumns): DvRow | undefined {
  const normalizedAgent = normalizeValue(agentName);
  const normalizedUser = normalizeValue(userName);

  return rows.find((row) =>
    normalizeValue(row[cols.agentname]) === normalizedAgent &&
    normalizeValue(row[cols.username]) === normalizedUser
  );
}

function patchDvState(rows: DvRow[], rowId: string | null | undefined, disabled: boolean, reason: string | null, cols: DvColumns, modifiedBy?: string | null): DvRow[] {
  if (!rowId) return rows;
  return rows.map((row) =>
    row[cols.id] === rowId
      ? {
          ...row,
          [cols.disableflag]: disabled,
          [cols.reason]: reason,
          [cols.lastmodifiedby]: modifiedBy ?? row[cols.lastmodifiedby],
          modifiedon: new Date().toISOString(),
        }
      : row
  );
}

function getSystemModifiedBy(row: DvRow): string {
  return (
    row["_modifiedby_value@OData.Community.Display.V1.FormattedValue"] ||
    row._modifiedby_value ||
    "—"
  );
}

function deriveActiveBlocks(rows: DvRow[], cols: DvColumns): ActiveBlock[] {
  return rows
    .filter((row) => row[cols.disableflag] === true && row[cols.id] && row[cols.agentname] && row[cols.username])
    .map((row) => ({
      id: row[cols.id] as string,
      dv_row_id: row[cols.id] as string,
      user_id: row[cols.username] as string,
      user_display_name: row[cols.username] || null,
      user_principal_name: row[cols.username] || null,
      bot_id: row[cols.agentname] as string,
      bot_name: row[cols.agentname] || null,
      block_scope: "agent" as const,
      blocked_by: row[cols.lastmodifiedby] || "unknown",
      system_modified_by: getSystemModifiedBy(row),
      blocked_at: row.modifiedon || row[cols.lastseeninsync] || new Date().toISOString(),
      block_reason: row[cols.reason] || null,
    }))
    .sort((a, b) => Date.parse(b.blocked_at) - Date.parse(a.blocked_at));
}

export default function DataverseTableClient({
  csrfToken,
  columnPrefix,
  canManageAccess,
  controlsDisabledReason,
}: {
  csrfToken: string;
  columnPrefix: string;
  canManageAccess: boolean;
  controlsDisabledReason: string | null;
}) {
  const cols = React.useMemo(() => getDvColumns(columnPrefix), [columnPrefix]);

  const COLUMNS = React.useMemo(() => [
    { key: cols.agentname, label: "Agent Name" },
    { key: cols.username, label: "User Name" },
    { key: cols.disableflag, label: "Disable Flag" },
    { key: cols.reason, label: "Flag Change Reason" },
    { key: cols.lastmodifiedby, label: "Last Modified By" },
    { key: "modifiedon", label: "Modified On" },
  ], [cols]);

  const [rows, setRows] = React.useState<DvRow[]>([]);
  const [sortConfig, setSortConfig] = React.useState<SortConfig>(() => ({ key: getDvColumns(columnPrefix).agentname, direction: "asc" }));
  const [dvLoading, setDvLoading] = React.useState(true);
  const [dvError, setDvError] = React.useState<string | null>(null);
  const [dvErrorType, setDvErrorType] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [blockError, setBlockError] = React.useState<string | null>(null);
  const [blockErrorType, setBlockErrorType] = React.useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = React.useState("");
  const [selectedUser, setSelectedUser] = React.useState("");
  const [quarantineContext, setQuarantineContext] = React.useState<QuarantineContext | null>(null);
  const [quarantineLoading, setQuarantineLoading] = React.useState(true);
  const [quarantineError, setQuarantineError] = React.useState<string | null>(null);
  const [quarantineSubmittingBotId, setQuarantineSubmittingBotId] = React.useState<string | null>(null);
  const [modal, setModal] = React.useState<{
    title: string;
    description: string;
    reason: string;
    onConfirm: (reason: string) => void;
  } | null>(null);

  const fetchDv = React.useCallback(async () => {
    try {
      const res = await fetch("/api/agents/agent-access-control");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDvError(data.error || `Failed to load (${res.status})`);
        setDvErrorType(data.dv_error_type || "unknown");
        return;
      }
      const data = await res.json();
      const nextRows = Array.isArray(data.rows)
        ? data.rows.filter((row: DvRow) => isUserDeleteFlagAllowed(row[cols.userdeleteflag]))
        : [];
      setRows(nextRows);
      setDvError(null);
      setDvErrorType(null);
    } catch {
      setDvError("Failed to fetch Dataverse data");
      setDvErrorType("unreachable");
    } finally {
      setDvLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchDv();
  }, [fetchDv]);

  const fetchQuarantineContext = React.useCallback(async () => {
    try {
      const res = await fetch("/api/copilot-quarantine/context");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setQuarantineError(data.error || `Failed to load (${res.status})`);
        return;
      }
      setQuarantineContext({
        canView: Boolean(data.canView),
        canAct: Boolean(data.canAct),
        needsConsent: Boolean(data.needsConsent),
        hasRequiredScope: Boolean(data.hasRequiredScope),
        roleCheck: data.roleCheck,
        agents: Array.isArray(data.agents) ? data.agents : [],
      });
      setQuarantineError(null);
    } catch {
      setQuarantineError("Failed to load quarantine data");
    } finally {
      setQuarantineLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchQuarantineContext();
  }, [fetchQuarantineContext]);

  const dvAgents = React.useMemo(() => {
    const seen = new Set<string>();
    return rows
      .filter((r) => r[cols.agentname])
      .reduce<string[]>((acc, r) => {
        const name = r[cols.agentname] as string;
        if (!seen.has(name)) {
          seen.add(name);
          acc.push(name);
        }
        return acc;
      }, [])
      .sort();
  }, [rows, cols]);

  const dvUsersForAgent = React.useMemo(() => {
    if (!selectedAgent) return [];
    const seen = new Set<string>();
    return rows
      .filter(
        (r) =>
          normalizeValue(r[cols.agentname]) === normalizeValue(selectedAgent) &&
          r[cols.username] &&
          r[cols.disableflag] !== true
      )
      .reduce<string[]>((acc, r) => {
        const name = r[cols.username] as string;
        if (!seen.has(name)) {
          seen.add(name);
          acc.push(name);
        }
        return acc;
      }, [])
      .sort();
  }, [rows, selectedAgent, cols]);

  const activeBlocks = React.useMemo(() => deriveActiveBlocks(rows, cols), [rows, cols]);
  const uniqueAssignedUsers = React.useMemo(() => {
    const seen = new Set<string>();
    rows.forEach((row) => {
      const user = normalizeValue(row[cols.username]);
      if (user) seen.add(user);
    });
    return seen.size;
  }, [rows, cols]);
  const quarantinedAgentsCount = React.useMemo(
    () => quarantineContext?.agents.filter((agent) => agent.isQuarantined).length ?? 0,
    [quarantineContext]
  );
  const sortedRows = React.useMemo(() => {
    const { key, direction } = sortConfig;
    const multiplier = direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = getSortableValue(a[key]);
      const right = getSortableValue(b[key]);
      if (left < right) return -1 * multiplier;
      if (left > right) return 1 * multiplier;
      return 0;
    });
  }, [rows, sortConfig]);

  function toggleSort(key: string) {
    setSortConfig((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "asc" }
    );
  }

  function handleBlock() {
    if (!canManageAccess || !selectedUser || !selectedAgent) return;
    setModal({
      title: "Confirm Block",
      description: `Block "${selectedUser}" from "${selectedAgent}"?`,
      reason: "",
      onConfirm: (reason) => executeBlock(reason),
    });
  }

  async function executeBlock(reason: string) {
    if (!canManageAccess) return;
    setSubmitting(true);
    setBlockError(null);
    const trimmedReason = reason.trim() || null;
    const dvRow = findDvRow(rows, selectedAgent, selectedUser, cols);
    try {
      const res = await fetch("/api/agents/access-blocks", {
        method: "POST",
        headers: getCsrfFetchHeaders({ "Content-Type": "application/json", "X-CSRF-Token": csrfToken }),
        body: JSON.stringify({
          action: "block",
          user_id: selectedUser,
          user_display_name: selectedUser,
          user_principal_name: selectedUser,
          bot_id: selectedAgent,
          bot_name: selectedAgent,
          block_scope: "agent",
          block_reason: trimmedReason,
          dv_row_id: dvRow?.[cols.id] ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBlockError(data.error || "Block failed");
        setBlockErrorType(data.dv_error_type || "unknown");
      } else {
        setBlockError(null);
        setBlockErrorType(null);
        setRows((prev) => patchDvState(prev, dvRow?.[cols.id], true, trimmedReason, cols));
        setSelectedUser("");
        setSelectedAgent("");
        await fetchDv();
      }
    } catch {
      setBlockError("Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  function handleUnblock(block: ActiveBlock) {
    if (!canManageAccess) return;
    setModal({
      title: "Confirm Unblock",
      description: `Unblock "${block.user_display_name || block.user_id}" from ${block.bot_name || block.bot_id}?`,
      reason: "",
      onConfirm: (reason) => executeUnblock(block, reason),
    });
  }

  async function executeUnblock(block: ActiveBlock, reason: string) {
    if (!canManageAccess) return;
    setSubmitting(true);
    setBlockError(null);
    const trimmedReason = reason.trim() || null;
    try {
      const res = await fetch("/api/agents/access-blocks", {
        method: "POST",
        headers: getCsrfFetchHeaders({ "Content-Type": "application/json", "X-CSRF-Token": csrfToken }),
        body: JSON.stringify({
          action: "unblock",
          user_id: block.user_id,
          user_display_name: block.user_display_name,
          user_principal_name: block.user_principal_name,
          bot_id: block.bot_id,
          bot_name: block.bot_name,
          block_scope: block.block_scope,
          unblock_reason: trimmedReason,
          dv_row_id: block.dv_row_id,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBlockError(data.error || "Unblock failed");
        setBlockErrorType(data.dv_error_type || "unknown");
      } else {
        setRows((prev) => patchDvState(prev, block.dv_row_id, false, trimmedReason, cols));
        await fetchDv();
      }
    } catch {
      setBlockError("Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  const selectClass = "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
  const formReady = selectedUser && selectedAgent && !submitting;

  async function executeQuarantineAction(agent: QuarantineAgent, reason: string) {
    const trimmedReason = reason.trim();
    if (!canManageAccess || !quarantineContext?.canAct || !trimmedReason) return;
    setQuarantineSubmittingBotId(agent.botId);
    setQuarantineError(null);
    const actionPath = agent.isQuarantined ? "/api/copilot-quarantine/unquarantine" : "/api/copilot-quarantine/quarantine";
    try {
      const res = await fetch(actionPath, {
        method: "POST",
        headers: getCsrfFetchHeaders({ "Content-Type": "application/json", "X-CSRF-Token": csrfToken }),
        body: JSON.stringify({ botId: agent.botId, botName: agent.botName, reason: trimmedReason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setQuarantineError(data.error || "Quarantine action failed");
        return;
      }
      if (data?.agent) {
        setQuarantineContext((current) =>
          current
            ? {
                ...current,
                agents: current.agents.map((row) => (row.botId === agent.botId ? data.agent : row)),
              }
            : current
        );
      }
      await fetchQuarantineContext();
    } catch {
      setQuarantineError("Quarantine action failed");
    } finally {
      setQuarantineSubmittingBotId(null);
    }
  }

  function handleQuarantineAction(agent: QuarantineAgent) {
    if (!canManageAccess || !quarantineContext?.canAct) return;
    const actionLabel = agent.isQuarantined ? "Unblock" : "Block";
    setModal({
      title: `Confirm ${actionLabel}`,
      description: `${actionLabel} "${agent.botName || agent.botId}" at the agent level?`,
      reason: "",
      onConfirm: (reason) => executeQuarantineAction(agent, reason),
    });
  }

  return (
    <main className="ps-page">
      <PageHeader
        title="Agent Access Control"
        subtitle="Manage Dataverse-backed user access assignments and agent quarantine controls."
        actions={
          <Link href="/dashboard/agents">
            <Button variant="outline" size="sm">
              {"<-"} Back to Agents
            </Button>
          </Link>
        }
      />

      <MetricGrid>
        <MetricCard
          label="Assignments"
          value={dvLoading ? "—" : rows.length.toLocaleString()}
          detail={dvLoading ? "Loading Dataverse records" : ""}
        />
        <MetricCard
          label="Agents"
          value={dvLoading ? "—" : dvAgents.length.toLocaleString()}
          detail={dvLoading ? "Loading distinct agents" : ""}
        />
        <MetricCard
          label="Assigned Users"
          value={dvLoading ? "—" : uniqueAssignedUsers.toLocaleString()}
          detail={dvLoading ? "Loading distinct users" : ""}
        />
        <MetricCard
          label="Active Blocks"
          value={dvLoading ? "—" : activeBlocks.length.toLocaleString()}
          detail={
            quarantineLoading
              ? "Loading quarantine status"
              : ""
          }
        />
      </MetricGrid>

      {(quarantineLoading || quarantineError || quarantineContext?.canView) && (
        <Card>
          <CardHeader>
            <CardTitle>
              Agent Quarantine Controls
              {!quarantineLoading && quarantineContext && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({quarantinedAgentsCount} quarantined)
                </span>
              )}
            </CardTitle>
            <CardDescription>
              Live quarantine status from Power Platform.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!canManageAccess && controlsDisabledReason ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
                {controlsDisabledReason}
              </div>
            ) : null}
            {quarantineLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : quarantineError ? (
              <DvErrorBanner errorType="unknown" rawError={quarantineError} />
            ) : quarantineContext && !quarantineContext.canAct ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
                {quarantineContext.needsConsent
                  ? "Power Platform delegated consent is required before block and unblock actions can run."
                  : "Your current session does not include the required Power Platform delegated scope for quarantine actions."}
              </div>
            ) : null}
            {quarantineContext && quarantineContext.agents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No agents found in the mapping table.</p>
            ) : quarantineContext ? (
              <div className="max-h-[460px] overflow-x-auto overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 bg-background">
                    <TableRow>
                      <TableHead>Bot Name</TableHead>
                      <TableHead>Last Modified</TableHead>
                      <TableHead>Current State</TableHead>
                      <TableHead className="w-28">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {quarantineContext.agents.map((agent) => (
                      <TableRow key={agent.botId}>
                        <TableCell>
                          <div className="font-medium">{agent.botName}</div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          <LocalDateTime value={agent.lastUpdateTimeUtc} fallback="—" />
                        </TableCell>
                        <TableCell>
                          <span className={agent.isQuarantined ? "font-medium text-red-600 dark:text-red-400" : "font-medium text-green-700 dark:text-green-400"}>
                            {agent.state}
                          </span>
                          {agent.error ? (
                            <div className="text-xs text-muted-foreground">{agent.error}</div>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!canManageAccess || !quarantineContext.canAct || quarantineSubmittingBotId === agent.botId || Boolean(agent.error)}
                            onClick={() => handleQuarantineAction(agent)}
                          >
                            {quarantineSubmittingBotId === agent.botId ? `${agent.actionLabel}ing...` : agent.actionLabel}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>
              Agent IAM Assignments
              {!dvLoading && !dvError && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({sortedRows.length} row{sortedRows.length !== 1 ? "s" : ""})
                </span>
              )}
            </CardTitle>
            <CardDescription>All agent-user assignments used by access management.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {dvLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : dvError ? (
            <DvErrorBanner errorType={dvErrorType} rawError={dvError} />
          ) : sortedRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rows found.</p>
          ) : (
            <div className="max-h-[640px] overflow-x-auto overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    {COLUMNS.map((col) => (
                      <TableHead key={col.key} className="whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className="inline-flex items-center gap-1 text-left font-medium hover:text-foreground"
                        >
                          <span>{col.label}</span>
                          <span className="text-xs text-muted-foreground">{getSortIndicator(sortConfig, col.key)}</span>
                        </button>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedRows.map((row, i) => (
                    <TableRow key={row[cols.id] || i}>
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      {COLUMNS.map((col) => {
                        const val = row[col.key];
                        const isDisableFlag = col.key === cols.disableflag;
                        const isTimestamp = TIMESTAMP_KEYS.has(col.key);
                        const isTrue = isDisableFlag && val === true;
                        const display =
                          val == null ? "—" : isTrue ? (
                            <span className="font-medium text-red-500">true</span>
                          ) : isTimestamp ? (
                            <LocalDateTime value={String(val)} fallback="—" />
                          ) : (
                            String(val)
                          );
                        return (
                          <TableCell key={col.key} className="max-w-xs truncate" title={val == null ? "" : String(val)}>
                            {display}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Block User from Agent</CardTitle>
          <CardDescription>Update agent-user assignments</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canManageAccess && controlsDisabledReason && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-100">
              {controlsDisabledReason}
            </div>
          )}
          {blockError && <DvErrorBanner errorType={blockErrorType} rawError={blockError} />}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
            <div className="min-w-0 space-y-1.5">
              <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent</label>
              <select
                value={selectedAgent}
                onChange={(e) => { setSelectedAgent(e.target.value); setSelectedUser(""); }}
                className={selectClass}
                disabled={!canManageAccess || submitting || dvLoading}
              >
                <option value="">Select agent...</option>
                {dvAgents.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>

            <div className="min-w-0 space-y-1.5">
              <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">User</label>
              <select
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
                className={selectClass}
                disabled={!canManageAccess || submitting || dvLoading || !selectedAgent}
              >
                <option value="">Select user...</option>
                {dvUsersForAgent.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5 lg:min-w-[180px]">
              <span className="block text-xs font-medium uppercase tracking-wide text-transparent select-none">
                Action
              </span>
              <Button
                variant="outline"
                disabled={!canManageAccess || !formReady}
                onClick={handleBlock}
                className="h-10 w-full border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
              >
                {submitting ? "Blocking..." : "Block from Agent"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Active Blocks
            {!dvLoading && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                ({activeBlocks.length} active)
              </span>
            )}
          </CardTitle>
          <CardDescription>Current agent-level user blocks derived from Dataverse.</CardDescription>
        </CardHeader>
        <CardContent>
          {dvLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : activeBlocks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active blocks.</p>
          ) : (
            <div className="max-h-[420px] overflow-x-auto overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Blocked By</TableHead>
                    <TableHead>Blocked At</TableHead>
                    <TableHead className="w-24">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeBlocks.map((block) => (
                    <TableRow key={block.id}>
                      <TableCell>
                        <span className="font-medium">
                          {block.user_principal_name || block.user_display_name || block.user_id}
                        </span>
                      </TableCell>
                      <TableCell>{block.bot_name || block.bot_id}</TableCell>
                      <TableCell className="max-w-[180px] truncate text-muted-foreground" title={block.block_reason || ""}>
                        {block.block_reason || <span className="text-muted-foreground/50">—</span>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{block.blocked_by}</TableCell>
                      <TableCell className="text-muted-foreground">
                        <LocalDateTime value={block.blocked_at} fallback="—" />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!canManageAccess || submitting}
                          onClick={() => handleUnblock(block)}
                        >
                          Unblock
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {modal && (
        <ConfirmModal
          title={modal.title}
          description={modal.description}
          initialReason={modal.reason}
          onConfirm={(reason) => { setModal(null); modal.onConfirm(reason); }}
          onCancel={() => setModal(null)}
        />
      )}
    </main>
  );
}

function DvErrorBanner({ errorType, rawError }: { errorType: string | null; rawError: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const { message, hint } = React.useMemo(() => {
    switch (errorType) {
      case "not_configured":
        return {
          message: "Dataverse integration is not configured on this server.",
          hint: "Check that DATAVERSE_BASE_URL and ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET are set in the web environment.",
        };
      case "auth_failed":
        return {
          message: "Authentication failed — could not obtain a Dataverse token.",
          hint: "The app service principal may have an expired client secret or incorrect credentials. Check the app registration in Azure Portal.",
        };
      case "permission_denied":
        return {
          message: "Permission denied — the app registration lacks access to this Dataverse environment.",
          hint: "Assign a Security Role (e.g. Basic User + table permissions) to the app in the Power Platform admin center under Environment → Users.",
        };
      case "unreachable":
        return {
          message: "Dataverse environment is unreachable.",
          hint: "The environment may be down, paused, or blocked by a firewall. Verify the DATAVERSE_BASE_URL and check the Power Platform admin center for environment status.",
        };
      default:
        return {
          message: "An unexpected Dataverse error occurred.",
          hint: "Check the web logs for the full stack trace.",
        };
    }
  }, [errorType]);

  function handleCopy() {
    navigator.clipboard.writeText(rawError).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-800 dark:bg-red-900/20">
      <p className="font-medium text-red-800 dark:text-red-300">{message}</p>
      <p className="mt-1 text-red-700 dark:text-red-400">{hint}</p>
      {errorType === "unknown" && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-red-600 underline dark:text-red-400"
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
          {expanded && (
            <div className="mt-2 rounded border border-red-200 bg-red-100 p-2 dark:border-red-700 dark:bg-red-900/40">
              <div className="flex items-start justify-between gap-2">
                <pre className="whitespace-pre-wrap break-all text-xs text-red-800 dark:text-red-300">{rawError}</pre>
                <button
                  onClick={handleCopy}
                  className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-xs text-red-700 hover:bg-red-200 dark:border-red-600 dark:text-red-400 dark:hover:bg-red-800/40"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfirmModal({
  title,
  description,
  initialReason,
  onConfirm,
  onCancel,
}: {
  title: string;
  description: string;
  initialReason: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = React.useState(initialReason);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg border bg-background p-6 shadow-lg">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        <div className="mt-4 flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">
            Reason <span className="text-red-500">*</span>
          </label>
          <input
            autoFocus
            type="text"
            placeholder="e.g. Security concern, Policy violation..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && reason.trim()) onConfirm(reason);
              if (e.key === "Escape") onCancel();
            }}
            className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" disabled={!reason.trim()} onClick={() => onConfirm(reason)}>Confirm</Button>
        </div>
      </div>
    </div>
  );
}
