"use client";

import * as React from "react";
import Link from "next/link";
import { getCsrfFetchHeaders } from "@/app/lib/csrf-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import LocalDateTime from "@/components/local-date-time";

const TIMESTAMP_KEYS = new Set(["cr6c3_lastseeninsync", "modifiedon"]);

const COLUMNS: { key: string; label: string }[] = [
  { key: "cr6c3_agentname", label: "Agent Name" },
  { key: "cr6c3_username", label: "User Name" },
  { key: "cr6c3_disableflagcopilot", label: "Disable Flag" },
  { key: "cr6c3_copilotflagchangereason", label: "Flag Change Reason" },
  { key: "cr6c3_userlastmodifiedby", label: "Last Modified By" },
  { key: "cr6c3_lastseeninsync", label: "Last Seen In Sync" },
  { key: "modifiedon", label: "Modified On" },
];

type DvRow = {
  cr6c3_table11id?: string;
  cr6c3_agentname?: string | null;
  cr6c3_username?: string | null;
  cr6c3_disableflagcopilot?: boolean | null;
  cr6c3_copilotflagchangereason?: string | null;
  cr6c3_userlastmodifiedby?: string | null;
  cr6c3_lastseeninsync?: string | null;
  modifiedon?: string | null;
  _modifiedby_value?: string | null;
  "_modifiedby_value@OData.Community.Display.V1.FormattedValue"?: string | null;
  [key: string]: any;
};

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

function normalizeValue(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function findDvRow(rows: DvRow[], agentName: string, userName: string): DvRow | undefined {
  const normalizedAgent = normalizeValue(agentName);
  const normalizedUser = normalizeValue(userName);

  return rows.find((row) =>
    normalizeValue(row.cr6c3_agentname) === normalizedAgent &&
    normalizeValue(row.cr6c3_username) === normalizedUser
  );
}

function patchDvState(rows: DvRow[], rowId: string | null | undefined, disabled: boolean, reason: string | null, modifiedBy?: string | null): DvRow[] {
  if (!rowId) return rows;
  return rows.map((row) =>
    row.cr6c3_table11id === rowId
      ? {
          ...row,
          cr6c3_disableflagcopilot: disabled,
          cr6c3_copilotflagchangereason: reason,
          cr6c3_userlastmodifiedby: modifiedBy ?? row.cr6c3_userlastmodifiedby,
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

function deriveActiveBlocks(rows: DvRow[]): ActiveBlock[] {
  return rows
    .filter((row) => row.cr6c3_disableflagcopilot === true && row.cr6c3_table11id && row.cr6c3_agentname && row.cr6c3_username)
    .map((row) => ({
      id: row.cr6c3_table11id as string,
      dv_row_id: row.cr6c3_table11id as string,
      user_id: row.cr6c3_username as string,
      user_display_name: row.cr6c3_username || null,
      user_principal_name: row.cr6c3_username || null,
      bot_id: row.cr6c3_agentname as string,
      bot_name: row.cr6c3_agentname || null,
      block_scope: "agent" as const,
      blocked_by: row.cr6c3_userlastmodifiedby || "unknown",
      system_modified_by: getSystemModifiedBy(row),
      blocked_at: row.modifiedon || row.cr6c3_lastseeninsync || new Date().toISOString(),
      block_reason: row.cr6c3_copilotflagchangereason || null,
    }))
    .sort((a, b) => Date.parse(b.blocked_at) - Date.parse(a.blocked_at));
}

export default function DataverseTableClient({ csrfToken }: { csrfToken: string }) {
  const [rows, setRows] = React.useState<DvRow[]>([]);
  const [dvLoading, setDvLoading] = React.useState(true);
  const [dvError, setDvError] = React.useState<string | null>(null);
  const [dvErrorType, setDvErrorType] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [blockError, setBlockError] = React.useState<string | null>(null);
  const [blockErrorType, setBlockErrorType] = React.useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = React.useState("");
  const [selectedUser, setSelectedUser] = React.useState("");
  const [blockReason, setBlockReason] = React.useState("");
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
      setRows(data.rows || []);
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

  const dvAgents = React.useMemo(() => {
    const seen = new Set<string>();
    return rows
      .filter((r) => r.cr6c3_agentname)
      .reduce<string[]>((acc, r) => {
        const name = r.cr6c3_agentname as string;
        if (!seen.has(name)) {
          seen.add(name);
          acc.push(name);
        }
        return acc;
      }, [])
      .sort();
  }, [rows]);

  const dvUsersForAgent = React.useMemo(() => {
    if (!selectedAgent) return [];
    const seen = new Set<string>();
    return rows
      .filter((r) => normalizeValue(r.cr6c3_agentname) === normalizeValue(selectedAgent) && r.cr6c3_username)
      .reduce<string[]>((acc, r) => {
        const name = r.cr6c3_username as string;
        if (!seen.has(name)) {
          seen.add(name);
          acc.push(name);
        }
        return acc;
      }, [])
      .sort();
  }, [rows, selectedAgent]);

  const activeBlocks = React.useMemo(() => deriveActiveBlocks(rows), [rows]);

  function handleBlock() {
    if (!selectedUser || !selectedAgent) return;
    setModal({
      title: "Confirm Block",
      description: `Block "${selectedUser}" from "${selectedAgent}"?`,
      reason: blockReason,
      onConfirm: (reason) => executeBlock(reason),
    });
  }

  async function executeBlock(reason: string) {
    setSubmitting(true);
    setBlockError(null);
    const trimmedReason = reason.trim() || null;
    const dvRow = findDvRow(rows, selectedAgent, selectedUser);
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
          dv_row_id: dvRow?.cr6c3_table11id ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBlockError(data.error || "Block failed");
        setBlockErrorType(data.dv_error_type || "unknown");
      } else {
        setBlockError(null);
        setBlockErrorType(null);
        setRows((prev) => patchDvState(prev, dvRow?.cr6c3_table11id, true, trimmedReason));
        setSelectedUser("");
        setSelectedAgent("");
        setBlockReason("");
        await fetchDv();
      }
    } catch {
      setBlockError("Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  function handleUnblock(block: ActiveBlock) {
    setModal({
      title: "Confirm Unblock",
      description: `Unblock "${block.user_display_name || block.user_id}" from ${block.bot_name || block.bot_id}?`,
      reason: "",
      onConfirm: (reason) => executeUnblock(block, reason),
    });
  }

  async function executeUnblock(block: ActiveBlock, reason: string) {
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
        setRows((prev) => patchDvState(prev, block.dv_row_id, false, trimmedReason));
        await fetchDv();
      }
    } catch {
      setBlockError("Request failed");
    } finally {
      setSubmitting(false);
    }
  }

  const selectClass = "rounded-md border border-input bg-background px-3 py-1.5 text-sm";
  const inputClass = "rounded-md border border-input bg-background px-3 py-1.5 text-sm";
  const formReady = selectedUser && selectedAgent && blockReason.trim() && !submitting;

  return (
    <main className="mx-auto max-w-[1400px] space-y-4 px-4 py-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agent-User Information</h1>
          <p className="text-sm text-muted-foreground">
            Live data from Dataverse - agent access assignments
          </p>
        </div>
        <Link href="/dashboard/agents">
          <Button variant="outline" size="sm">
            {"<-"} Back to Agents
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>
              Agent Access Records
              {!dvLoading && !dvError && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({rows.length} row{rows.length !== 1 ? "s" : ""})
                </span>
              )}
            </CardTitle>
            <CardDescription>All agent-user assignments from Dataverse</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {dvLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : dvError ? (
            <DvErrorBanner errorType={dvErrorType} rawError={dvError} />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rows found.</p>
          ) : (
            <div className="max-h-[600px] overflow-x-auto overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background">
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    {COLUMNS.map((col) => (
                      <TableHead key={col.key} className="whitespace-nowrap">
                        {col.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row, i) => (
                    <TableRow key={row.cr6c3_table11id || i}>
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      {COLUMNS.map((col) => {
                        const val = row[col.key];
                        const isDisableFlag = col.key === "cr6c3_disableflagcopilot";
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
          <CardDescription>Update the Dataverse access record for a specific agent-user assignment</CardDescription>
        </CardHeader>
        <CardContent>
          {blockError && (
            <div className="mb-4">
              <DvErrorBanner errorType={blockErrorType} rawError={blockError} />
            </div>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Agent</label>
              <select
                value={selectedAgent}
                onChange={(e) => { setSelectedAgent(e.target.value); setSelectedUser(""); }}
                className={selectClass}
                disabled={submitting || dvLoading}
              >
                <option value="">Select agent...</option>
                {dvAgents.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">
                User{selectedAgent && dvUsersForAgent.length === 0 && (
                  <span className="ml-1 text-amber-600">(no users found for this agent)</span>
                )}
              </label>
              <select
                value={selectedUser}
                onChange={(e) => setSelectedUser(e.target.value)}
                className={selectClass}
                disabled={submitting || dvLoading || !selectedAgent}
              >
                <option value="">Select user...</option>
                {dvUsersForAgent.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">
                Reason <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Security concern, Policy violation..."
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                className={inputClass + " w-64"}
                disabled={submitting}
              />
            </div>

            <Button
              variant="outline"
              size="sm"
              disabled={!formReady}
              onClick={handleBlock}
              className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-900/20"
            >
              {submitting ? "Blocking..." : "Block from Agent"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {!dvLoading && (
        <Card>
          <CardHeader>
            <CardTitle>Active Blocks</CardTitle>
            <CardDescription>Derived from Dataverse rows where the disable flag is true</CardDescription>
          </CardHeader>
          <CardContent>
            {activeBlocks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active blocks.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Blocked By</TableHead>
                      <TableHead>System Modified By</TableHead>
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
                        <TableCell className="max-w-[160px] truncate text-muted-foreground" title={block.block_reason || ""}>
                          {block.block_reason || <span className="text-muted-foreground/50">—</span>}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{block.blocked_by}</TableCell>
                        <TableCell className="text-muted-foreground">{block.system_modified_by}</TableCell>
                        <TableCell className="text-muted-foreground">
                          <LocalDateTime value={block.blocked_at} fallback="—" />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={submitting}
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
      )}

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
          hint: "Check that DATAVERSE_URL and ENTRA_TENANT_ID / ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET are set in the worker environment.",
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
          hint: "The environment may be down, paused, or blocked by a firewall. Verify the DATAVERSE_URL and check the Power Platform admin center for environment status.",
        };
      default:
        return {
          message: "An unexpected Dataverse error occurred.",
          hint: "Check the worker logs for the full stack trace.",
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
