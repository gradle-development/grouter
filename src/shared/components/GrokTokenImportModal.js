"use client";

import { useState } from "react";
import { Modal, Button, Input } from "@/shared/components";

export default function GrokTokenImportModal({ isOpen, onClose, onSaved }) {
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  function handleClose() {
    setAccessToken("");
    setRefreshToken("");
    setEmail("");
    setError(null);
    onClose?.();
  }

  async function handleImport() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/grok-cli/import-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessToken: accessToken.trim(),
          refreshToken: refreshToken.trim(),
          email: email.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Import failed");
        return;
      }
      setAccessToken("");
      setRefreshToken("");
      setEmail("");
      onSaved?.();
      handleClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const canSubmit = Boolean(accessToken.trim() && refreshToken.trim() && !loading);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Import Grok CLI Account" size="md">
      <div className="space-y-3">
        <p className="text-xs text-text-muted">
          Paste OAuth tokens from CPA / grok-cli device flow. Saves a{" "}
          <strong>grok-cli</strong> connection only.
        </p>
        <Input
          label="Access Token"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder="eyJ..."
          required
        />
        <Input
          label="Refresh Token"
          value={refreshToken}
          onChange={(e) => setRefreshToken(e.target.value)}
          placeholder="eyJ... or refresh token"
          required
        />
        <Input
          label="Email (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="account@example.com"
          hint="Used as connection name when set."
        />
        {error && (
          <p className="text-sm text-red-500 break-words" role="alert">
            {error}
          </p>
        )}
        <div className="flex gap-2 justify-end pt-2">
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="primary" loading={loading} onClick={handleImport} disabled={!canSubmit}>
            Import
          </Button>
        </div>
      </div>
    </Modal>
  );
}
