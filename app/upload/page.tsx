"use client";

import { useState } from "react";

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    setError(null);
    if (!file) {
      setError("Please choose a file first.");
      return;
    }

    const form = new FormData();
    form.append("file", file);

    const res = await fetch("/api/upload", {
      method: "POST",
      body: form,
    });

    const data = await res.json();

    if (!res.ok) {
      setError(data?.error || "Upload failed");
      return;
    }

    setUploadId(data.uploadId);
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Upload Technology Inventory</h1>

      <input
        type="file"
        accept=".csv"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
      />

      <div style={{ marginTop: 12 }}>
        <button onClick={upload}>Upload</button>
      </div>

      {error && <p style={{ color: "red" }}>{error}</p>}

      {uploadId && (
        <p style={{ marginTop: 16 }}>
          Upload created: <code>{uploadId}</code>
          <br />
          <a href={`/results/${uploadId}`}>➡️ View Processing Status</a>
        </p>
      )}
    </main>
  );
}
