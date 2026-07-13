"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Badge from "./Badge";
import Button from "./Button";
import Modal from "./Modal";
import { readJsonResponse } from "@/shared/utils/httpResponse.js";

const PROVIDER = "grok-cli";
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "needs_manual"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STORAGE_KEY = "grok-cli-sso-import-active-job";

function getStatusVariant(status) {
  if (status === "success" || status === "completed") return "success";
  if (status === "needs_manual") return "warning";
  if (status === "running" || status === "queued") return "info";
  if (status === "cancelled") return "default";
  return "danger";
}

function formatStepLabel(value) {
  return String(value || "waiting").replaceAll("_", " ");
}

async function fetchJob(jobId) {
  const res = await fetch(`/api/oauth/${PROVIDER}/bulk-import/${jobId}`, { cache: "no-store" });
  const data = await readJsonResponse(res, "Failed to fetch job");
  return { res, data };
}

async function fetchLatestJob() {
  const res = await fetch(`/api/oauth/${PROVIDER}/bulk-import/latest?scope=recoverable`, {
    cache: "no-store",
  });
  if (res.status === 404 || !res.ok) return { res, data: { success: false, job: null } };
  const data = await readJsonResponse(res, "Failed to fetch latest job");
  return { res, data };
}

function isSsoImportJob(job) {
  if (!job) return false;
  const meta = job.accountsMeta || [];
  if (meta.some((a) => a?.mode === "sso-import")) return true;
  // recover jobs started before mode was stored
  if (Number(job.registerCount) > 0) return false;
  if (meta.some((a) => a?.mode === "token-import" || a?.accessToken)) return false;
  return meta.some((a) => a?.sso);
}

export default function GrokSsoImportModal({ isOpen, onClose, onSuccess }) {
  const [accountsText, setAccountsText] = useState("");
  const [activeJob, setActiveJob] = useState(null);
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const completedRefreshRef = useRef(new Set());

  const runningJob = activeJob && ACTIVE_JOB_STATUSES.has(activeJob.status);
  const finishedJob = activeJob && TERMINAL_JOB_STATUSES.has(activeJob.status);

  const resetState = useCallback(() => {
    setActiveJob(null);
    setError(null);
    setImporting(false);
    if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const stored =
          typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
        if (stored) {
          const { res, data } = await fetchJob(stored);
          if (!cancelled && res.ok && data?.job && isSsoImportJob(data.job)) {
            setActiveJob(data.job);
            return;
          }
        }
        const { res, data } = await fetchLatestJob();
        if (
          !cancelled &&
          res.ok &&
          data?.job &&
          ACTIVE_JOB_STATUSES.has(data.job.status) &&
          isSsoImportJob(data.job)
        ) {
          setActiveJob(data.job);
          if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, data.job.jobId);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !activeJob?.jobId || finishedJob) return;
    const interval = setInterval(async () => {
      try {
        const { res, data } = await fetchJob(activeJob.jobId);
        if (res.ok && data?.job) {
          setActiveJob(data.job);
          if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, data.job.jobId);
          if (
            TERMINAL_JOB_STATUSES.has(data.job.status) &&
            !completedRefreshRef.current.has(data.job.jobId)
          ) {
            completedRefreshRef.current.add(data.job.jobId);
            onSuccess?.();
          }
        }
      } catch {
        /* ignore */
      }
    }, 2500);
    return () => clearInterval(interval);
  }, [activeJob?.jobId, finishedJob, isOpen, onSuccess]);

  const groupedAccounts = useMemo(() => {
    const groups = new Map();
    for (const account of activeJob?.accounts || []) {
      const key = account.status || "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(account);
    }
    return [...groups.entries()].map(([status, accounts]) => ({ status, accounts }));
  }, [activeJob]);

  const handleStart = async () => {
    setImporting(true);
    setError(null);
    try {
      const accounts = accountsText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      if (!accounts.length) throw new Error("Paste at least one email|password|sso line");

      const res = await fetch(`/api/oauth/${PROVIDER}/bulk-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts, concurrency: 1 }),
      });
      const data = await readJsonResponse(res, "Failed to start Grok SSO import");
      if (!res.ok || data.error) throw new Error(data.error || "Failed to start job");
      setActiveJob(data.job || null);
      if (data.job?.jobId) {
        completedRefreshRef.current.delete(data.job.jobId);
        if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, data.job.jobId);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleCancel = async () => {
    if (!activeJob?.jobId) return;
    try {
      const res = await fetch(`/api/oauth/${PROVIDER}/bulk-import/${activeJob.jobId}/cancel`, {
        method: "POST",
      });
      const data = await readJsonResponse(res, "Failed to cancel");
      if (!res.ok || data.error) throw new Error(data.error || "Cancel failed");
      if (data.job) setActiveJob(data.job);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Grok CLI Import SSO"
      onClose={onClose}
      size="full"
      className="max-w-[min(96vw,1100px)]"
    >
      <div className="flex flex-col gap-4">
        {!activeJob && (
          <>
            <div className="rounded-lg border border-border bg-surface p-3 text-sm text-text-muted">
              Bulk paste existing Grok accounts. Each line:{" "}
              <code className="rounded bg-background px-1">email|password|sso</code> (or{" "}
              <code className="rounded bg-background px-1">----</code>). CPA mints device OAuth →
              saves <strong>grok-cli</strong> only. Needs Chrome/Chromium +{" "}
              <code className="rounded bg-background px-1">python -m grokreg mint-sso</code>.
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">Accounts</label>
              <textarea
                className="min-h-[160px] w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs"
                value={accountsText}
                onChange={(e) => setAccountsText(e.target.value)}
                placeholder={"user@example.com|password|sso_cookie_value\nuser2@example.com|pass2|sso=other..."}
              />
            </div>

            {error && (
              <p className="text-sm text-red-500" role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" loading={importing} onClick={handleStart}>
                Start bulk import
              </Button>
            </div>
          </>
        )}

        {activeJob && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={getStatusVariant(activeJob.status)}>
                {formatStepLabel(activeJob.status)}
              </Badge>
              <span className="text-xs text-text-muted">job {activeJob.jobId}</span>
              {runningJob && (
                <Button size="sm" variant="danger" onClick={handleCancel}>
                  Cancel
                </Button>
              )}
              {finishedJob && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    resetState();
                    onSuccess?.();
                  }}
                >
                  Done
                </Button>
              )}
              {finishedJob && (
                <Button size="sm" variant="secondary" onClick={resetState}>
                  New job
                </Button>
              )}
            </div>

            {error && (
              <p className="text-sm text-red-500" role="alert">
                {error}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              {groupedAccounts.map(({ status, accounts }) => (
                <div key={status} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge variant={getStatusVariant(status)} size="sm">
                      {formatStepLabel(status)}
                    </Badge>
                    <span className="text-xs text-text-muted">{accounts.length}</span>
                  </div>
                  <ul className="max-h-48 space-y-1 overflow-auto text-xs">
                    {accounts.map((a) => (
                      <li key={a.line} className="truncate text-text-muted">
                        #{a.line} {a.email || ""} · {formatStepLabel(a.currentStep || a.status)}
                        {a.error ? ` — ${a.error}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="max-h-56 overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-[11px] text-text-muted">
              {(activeJob.activity || [])
                .slice(-40)
                .reverse()
                .map((item, i) => (
                  <div key={i}>
                    {item.at || item.time || ""} {item.message || item.step || JSON.stringify(item)}
                  </div>
                ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
