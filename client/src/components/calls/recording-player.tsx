"use client";

// Plays a call recording from the phone app.
//
// The recording is behind the login (only the caller who made the call and
// admins may hear it, and each listen is logged), so a plain <audio src> -
// which cannot send the login header - will not do. It is fetched once on
// "Play" and handed to the player as a local blob.
//
// AMR, which some phones record in, does not play in browsers; Download is
// always offered beside the player so it can be opened on the phone instead.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icons";

export function RecordingPlayer({ url, label = "Play recording" }: { url: string; label?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const blob = await apiClient.getBlob(url);
      setType(blob.type);
      setSrc(URL.createObjectURL(blob));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not play.");
    } finally {
      setBusy(false);
    }
  }

  if (!src) {
    return (
      <span className="inline-flex items-center gap-2">
        <Button size="xs" variant="secondary" icon="arrowRight" loading={busy} onClick={() => void load()}>
          {label}
        </Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </span>
    );
  }

  const ext = type.includes("amr") ? "amr" : type.includes("mpeg") ? "mp3" : type.includes("mp4") ? "m4a" : "audio";
  return (
    <span className="mt-1 flex flex-wrap items-center gap-2">
      <audio controls autoPlay src={src} className="h-9 max-w-full" />
      <a href={src} download={`call-recording.${ext}`} className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">
        <Icon name="download" size={13} /> Download
      </a>
    </span>
  );
}
