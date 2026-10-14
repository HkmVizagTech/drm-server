"use client";

// Plays a call recording from the phone app.
//
// The recording is behind the login (only the caller who made the call and
// admins may hear it, and each listen is logged), so a plain <audio src> -
// which cannot send the login header - will not do. It is fetched once, on the
// first press of Play, and handed to the player as a local file.
//
// One control everywhere: a round play button, the time, and once playing a
// bar to jump about, a speed button (1×, 1.5×, 2× - a long call reviewed at
// 1.5× takes two thirds of the time) and Download. AMR, which a few phones
// record in, does not play in browsers; Download is offered instead.

import { useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import { clock } from "@/lib/phone-calls";
import { Icon, Spinner } from "@/components/icons";

const SPEEDS = [1, 1.5, 2];

export function RecordingPlayer({
  url,
  seconds,
  size = "md",
}: {
  url: string;
  /** Talk time from the phone, shown before the file is fetched. */
  seconds?: number;
  size?: "sm" | "md" | "lg";
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [type, setType] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(seconds ?? 0);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (src) URL.revokeObjectURL(src);
    };
  }, [src]);

  async function toggle() {
    setError(null);
    if (src && audio.current) {
      if (audio.current.paused) void audio.current.play().catch(() => undefined);
      else audio.current.pause();
      return;
    }
    setBusy(true);
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

  // Start as soon as the file is in.
  useEffect(() => {
    if (src && audio.current) void audio.current.play().catch(() => undefined);
  }, [src]);

  const ext = type.includes("amr") ? "amr" : type.includes("mpeg") ? "mp3" : type.includes("wav") ? "wav" : type.includes("mp4") ? "m4a" : "audio";
  const btn = size === "lg" ? "h-12 w-12" : size === "sm" ? "h-8 w-8" : "h-10 w-10";
  const iconSize = size === "lg" ? 20 : size === "sm" ? 14 : 17;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2.5">
        <button
          type="button"
          onClick={() => void toggle()}
          aria-label={playing ? "Pause recording" : "Play recording"}
          className={`grid flex-none place-items-center rounded-full bg-brand-600 text-white shadow-button transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 focus-visible:ring-offset-2 ${btn}`}
        >
          {busy ? <Spinner size={iconSize} /> : <Icon name={playing ? "pause" : "play"} size={iconSize} className={playing ? "" : "translate-x-px"} />}
        </button>

        {src ? (
          <>
            <input
              type="range"
              min={0}
              max={length || 0}
              step={0.1}
              value={Math.min(at, length || 0)}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (audio.current) audio.current.currentTime = v;
                setAt(v);
              }}
              aria-label="Position in the recording"
              className="h-1.5 min-w-0 flex-1 cursor-pointer accent-brand-600"
            />
            <span className="flex-none text-xs tabular-nums text-ink-muted">
              {clock(at)} / {clock(length)}
            </span>
            <button
              type="button"
              onClick={() => {
                const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
                setSpeed(next);
                if (audio.current) audio.current.playbackRate = next;
              }}
              className="flex-none rounded-control border border-line px-1.5 py-0.5 text-xs font-medium tabular-nums text-ink-soft hover:bg-sunken"
              aria-label="Playback speed"
            >
              {speed}×
            </button>
            <a
              href={src}
              download={`call-recording.${ext}`}
              aria-label="Download recording"
              className="grid h-7 w-7 flex-none place-items-center rounded-control text-ink-muted hover:bg-sunken hover:text-brand-700"
            >
              <Icon name="download" size={15} />
            </a>
          </>
        ) : (
          <span className="text-sm tabular-nums text-ink-muted">
            {seconds ? clock(seconds) : "Play recording"}
          </span>
        )}
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
      {src && (
        <audio
          ref={audio}
          src={src}
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setLength(d);
            e.currentTarget.playbackRate = speed;
          }}
          onError={() => setError("This recording can't play here. Use Download to listen on the phone.")}
          className="hidden"
        />
      )}
    </div>
  );
}
