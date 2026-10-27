"use client";
import type {
  FewShotExample,
  WorkspaceTaxonomy,
} from "@/lib/classifier/taxonomy";
import { useState } from "react";

type TaxonomyItem = {
  id: string;
  workspace_id: string;
  vertical?: string | null;
  labels: string[];
  guidelines?: string | null;
  few_shots?: FewShotExample[];
  confidence_threshold?: number | null;
  version?: string | null;
  updated_at?: string;
};

type TaxonomyForm = {
  id: string | null;
  workspace_id: string;
  vertical?: string;
  labels: string[];
  guidelines?: string;
  confidence_threshold?: number;
  few_shots?: FewShotExample[];
  version?: string;
};

export function TaxonomyEditor({
  initialItems,
  defaultTemplate,
}: {
  initialItems: TaxonomyItem[];
  defaultTemplate: WorkspaceTaxonomy;
}) {
  const [items, setItems] = useState<TaxonomyItem[]>(initialItems || []);
  const [form, setForm] = useState<TaxonomyForm>({
    id: null,
    workspace_id: "",
    vertical: "",
    labels: defaultTemplate.labels,
    guidelines: defaultTemplate.guidelines,
    confidence_threshold: defaultTemplate.confidenceThreshold,
    few_shots: defaultTemplate.fewShots || [],
    version: defaultTemplate.version,
  });

  async function save() {
    const res = await fetch("/api/taxonomies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const json = await res.json();
    if (res.ok) {
      const listRes = await fetch("/api/taxonomies");
      const listJson = await listRes.json();
      setItems(listJson.items || []);
      setForm({ ...form, id: null });
    } else {
      alert(json?.error || "Failed to save taxonomy");
    }
  }

  function addLabel() {
    setForm(f => ({ ...f, labels: [...(f.labels || []), ""] }));
  }

  function removeLabel(i: number) {
    setForm(f => ({
      ...f,
      labels: (f.labels || []).filter((_, idx) => idx !== i),
    }));
  }

  function addFewShot() {
    setForm(f => ({
      ...f,
      few_shots: [...(f.few_shots || []), { text: "", label: "" }],
    }));
  }

  function removeFewShot(i: number) {
    setForm(f => ({
      ...f,
      few_shots: (f.few_shots || []).filter((_, idx) => idx !== i),
    }));
  }

  function edit(item: TaxonomyItem) {
    setForm({
      id: item.id,
      workspace_id: item.workspace_id,
      vertical: item.vertical || "",
      labels: item.labels || defaultTemplate.labels,
      guidelines: item.guidelines || defaultTemplate.guidelines,
      few_shots: item.few_shots || defaultTemplate.fewShots || [],
      confidence_threshold:
        typeof item.confidence_threshold === "number"
          ? item.confidence_threshold
          : defaultTemplate.confidenceThreshold,
      version: item.version || defaultTemplate.version,
    });
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <div className="space-y-4">
        <div className="border rounded p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Edit Taxonomy</h2>
            <button className="btn btn-primary" onClick={save}>
              Save
            </button>
          </div>
          <label className="block text-sm">Workspace ID</label>
          <input
            className="input input-bordered w-full"
            value={form.workspace_id}
            onChange={e => setForm({ ...form, workspace_id: e.target.value })}
            placeholder="uuid"
          />

          <label className="block text-sm mt-3">Vertical (optional)</label>
          <input
            className="input input-bordered w-full"
            value={form.vertical}
            onChange={e => setForm({ ...form, vertical: e.target.value })}
            placeholder="e.g., ecommerce"
          />

          <label className="block text-sm mt-3">Guidelines</label>
          <textarea
            className="textarea textarea-bordered w-full"
            rows={4}
            value={form.guidelines}
            onChange={e => setForm({ ...form, guidelines: e.target.value })}
          />

          <div className="mt-3">
            <div className="flex items-center justify-between">
              <label className="text-sm">Labels (top 20)</label>
              <button className="btn btn-sm" onClick={addLabel}>
                Add
              </button>
            </div>
            <div className="space-y-2 mt-2">
              {(form.labels || []).map((label: string, i: number) => (
                <div className="flex gap-2" key={`label-${i}`}>
                  <input
                    className="input input-bordered w-full"
                    value={label}
                    onChange={e => {
                      const next = [...form.labels];
                      next[i] = e.target.value;
                      setForm({ ...form, labels: next });
                    }}
                  />
                  <button
                    className="btn btn-ghost"
                    onClick={() => removeLabel(i)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3">
            <div className="flex items-center justify-between">
              <label className="text-sm">Few-shots</label>
              <button className="btn btn-sm" onClick={addFewShot}>
                Add
              </button>
            </div>
            <div className="space-y-2 mt-2">
              {(form.few_shots || []).map((fs: FewShotExample, i: number) => (
                <div
                  className="grid grid-cols-1 md:grid-cols-3 gap-2"
                  key={`fs-${i}`}
                >
                  <input
                    className="input input-bordered w-full md:col-span-2"
                    placeholder="Text"
                    value={fs.text}
                    onChange={e => {
                      const next = [...(form.few_shots || [])];
                      next[i] = { ...next[i], text: e.target.value };
                      setForm({ ...form, few_shots: next });
                    }}
                  />
                  <input
                    className="input input-bordered w-full"
                    placeholder="Label"
                    value={fs.label}
                    onChange={e => {
                      const next = [...(form.few_shots || [])];
                      next[i] = { ...next[i], label: e.target.value };
                      setForm({ ...form, few_shots: next });
                    }}
                  />
                  <div className="md:col-span-3">
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => removeFewShot(i)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <label className="block text-sm mt-3">Confidence threshold</label>
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            className="input input-bordered w-full"
            value={form.confidence_threshold}
            onChange={e =>
              setForm({
                ...form,
                confidence_threshold: parseFloat(e.target.value),
              })
            }
          />

          <label className="block text-sm mt-3">Version</label>
          <input
            className="input input-bordered w-full"
            value={form.version}
            onChange={e => setForm({ ...form, version: e.target.value })}
          />
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="font-medium">Existing Taxonomies</h2>
        <div className="border rounded divide-y">
          {items.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">
              No taxonomies yet
            </div>
          )}
          {items.map((it: TaxonomyItem) => (
            <div
              key={it.id}
              className="p-4 hover:bg-muted cursor-pointer"
              onClick={() => edit(it)}
            >
              <div className="font-mono text-xs">{it.workspace_id}</div>
              <div className="text-sm">
                {(it.labels || []).slice(0, 5).join(", ")}
                {(it.labels || []).length > 5 ? "…" : ""}
              </div>
              <div className="text-xs text-muted-foreground">
                {new Date(it.updated_at || "").toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
