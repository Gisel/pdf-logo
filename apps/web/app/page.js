"use client";

import { useMemo, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001";

export default function Page() {
  const [file, setFile] = useState(null);
  const [format, setFormat] = useState("style_a");
  const [jobId, setJobId] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const canUpload = useMemo(() => Boolean(file) && status !== "uploading", [file, status]);

  async function upload() {
    if (!file) return;

    setError("");
    setStatus("uploading");

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_BASE}/v1/jobs?format=${encodeURIComponent(format)}`, {
        method: "POST",
        body: formData
      });

      const json = await response.json();
      if (!response.ok) {
        throw new Error(json.error || "Upload failed");
      }

      setJobId(json.jobId);
      setStatus("queued");
      pollStatus(json.jobId);
    } catch (err) {
      setStatus("idle");
      setError(err.message || "Unexpected error");
    }
  }

  async function pollStatus(id) {
    const interval = setInterval(async () => {
      const response = await fetch(`${API_BASE}/v1/jobs/${id}`);
      const json = await response.json();

      if (!response.ok) {
        clearInterval(interval);
        setError(json.error || "Status failed");
        setStatus("idle");
        return;
      }

      setStatus(json.status);

      if (["completed", "failed", "needs_review"].includes(json.status)) {
        clearInterval(interval);
      }
    }, 1500);
  }

  function downloadLink() {
    return `${API_BASE}/v1/jobs/${jobId}/download`;
  }

  function auditLink() {
    return `${API_BASE}/v1/jobs/${jobId}/audit`;
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", background: "#ffffff", padding: 24, borderRadius: 12, boxShadow: "0 8px 30px rgba(15,23,42,0.08)" }}>
      <h1 style={{ marginTop: 0 }}>PDF Logo Cambio a FICUA</h1>
      <p>Sube el PDF para que cambie el logo.</p>

      <div style={{ display: "grid", gap: 12 }}>
        <input
          type="file"
          accept="application/pdf"
          onChange={(event) => setFile(event.target.files?.[0] || null)}
        />
        <label style={{ display: "grid", gap: 6 }}>
          <span>Formato</span>
          <select value={format} onChange={(event) => setFormat(event.target.value)}>
            <option value="style_a">Estilo A (Constelaciones Morado)</option>
            <option value="style_b">Estilo B (Gestalt)</option>
            <option value="style_c">Estilo C (Constelaciones con el Footer Alto)</option>
          </select>
        </label>

        <button
          type="button"
          onClick={upload}
          disabled={!canUpload}
          style={{ width: 180, height: 40 }}
        >
          {status === "uploading" ? "Uploading..." : "Subir PDF"}
        </button>
      </div>

      <hr style={{ margin: "20px 0" }} />

      <p><strong>Status:</strong> {status}</p>
      {jobId && <p><strong>Job ID:</strong> {jobId}</p>}
      {error && <p style={{ color: "#b91c1c" }}>{error}</p>}

      {["completed", "needs_review"].includes(status) && (
        <div style={{ display: "flex", gap: 12 }}>
          <a href={downloadLink()}>Bajar el PDF limpio</a>
          <a href={auditLink()} target="_blank" rel="noreferrer">Ver auditoría JSON</a>
        </div>
      )}
    </main>
  );
}
