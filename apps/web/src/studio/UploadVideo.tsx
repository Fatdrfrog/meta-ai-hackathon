import { useId, useRef, useState } from "react";

const TIPS = [
  "Hold each item still for two seconds while you say its name.",
  "Say one price per item: “this doll is five thousand”.",
  "Hold items by the base or the edge, not across the front.",
];

export function UploadVideo({
  upload,
  onUploaded,
  prominent,
}: {
  upload: (file: File, onProgress: (fraction: number) => void) => Promise<void>;
  onUploaded: () => void;
  prominent: boolean;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(file: File) {
    setError(null);
    setProgress(0);
    try {
      await upload(file, setProgress);
      onUploaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  }

  const uploading = progress !== null;
  return (
    <div>
      <input
        ref={input}
        id={inputId}
        type="file"
        accept="video/*"
        className="sr-only"
        disabled={uploading}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
        }}
      />
      <div className={prominent ? "flex flex-col items-start gap-4" : "flex flex-wrap items-center gap-x-4 gap-y-2"}>
        <label
          htmlFor={inputId}
          aria-disabled={uploading}
          className={`inline-flex cursor-pointer items-center rounded-md bg-action px-5 font-medium text-white hover:bg-action-dark has-[:focus-visible]:outline-3 aria-disabled:cursor-wait aria-disabled:opacity-70 ${prominent ? "py-3 text-lg" : "py-2"}`}
        >
          {uploading ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : prominent ? "Upload a video" : "Add products from a video"}
        </label>
        {!prominent && !uploading && <span className="text-sm text-ink-soft">Film more products and they join the shelf.</span>}
      </div>
      {uploading && (
        <div className="mt-3 h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-line" role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round((progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-action transition-[width]" style={{ width: `${(progress ?? 0) * 100}%` }} />
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-check">
          Upload failed: {error}
        </p>
      )}
      {prominent && (
        <ul className="mt-8 max-w-xl space-y-2 text-ink-soft">
          {TIPS.map((tip) => (
            <li key={tip} className="border-l-2 border-tag pl-3">
              {tip}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
