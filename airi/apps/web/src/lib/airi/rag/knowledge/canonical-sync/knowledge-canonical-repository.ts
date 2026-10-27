import "server-only";

import type {
  DeleteKnowledgeDocumentBySourceParams,
  FinishKnowledgeSyncRunParams,
  StartKnowledgeSyncRunParams,
  UpsertKnowledgeDocumentParams,
} from "@/lib/airi/rag/kb/kb-types";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type CanonicalChunk = {
  chunkIndex: number;
  content: string;
  locale: string | null;
  headingPath: string[] | null;
  citationLabel: string | null;
  documentTitle: string | null;
  embedding: number[] | string | null;
  authorityScore: number;
  metadata: Record<string, unknown>;
};

export type KnowledgeDocumentSnapshot = {
  id: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  chunks: CanonicalChunk[];
};

export type KnowledgeReconciliationSnapshot = {
  id: string;
  updatedAt: string;
  sourceRecordId: string;
};

/** Read every scoped canonical version before taking a cross-store source snapshot. */
export async function getKnowledgeDocumentsForReconciliation(params: {
  workspaceId: string;
  sourceKind: string;
  sourceRecordIds?: string[];
}): Promise<KnowledgeReconciliationSnapshot[]> {
  const documents: KnowledgeReconciliationSnapshot[] = [];
  const pageSize = 1000;
  let afterId: string | undefined;
  for (;;) {
    let query = supabaseAdmin
      .from("knowledge_documents")
      .select("id, updated_at, source_record_id")
      .eq("workspace_id", params.workspaceId)
      .eq("source_kind", params.sourceKind)
      .order("id", { ascending: true })
      .limit(pageSize);
    if (params.sourceRecordIds)
      query = query.in("source_record_id", params.sourceRecordIds);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error)
      throw new Error(
        `knowledge reconciliation snapshot failed: ${error.message}`
      );
    const rows = data ?? [];
    documents.push(
      ...rows.map(row => ({
        id: row.id,
        updatedAt: row.updated_at,
        sourceRecordId: row.source_record_id,
      }))
    );
    if (rows.length < pageSize) return documents;
    afterId = rows[rows.length - 1].id;
  }
}

export async function getKnowledgeDocumentSnapshot(
  params: DeleteKnowledgeDocumentBySourceParams
): Promise<KnowledgeDocumentSnapshot | null> {
  const { data, error } = await supabaseAdmin
    .from("knowledge_documents")
    .select(
      "id, updated_at, metadata, knowledge_chunks(chunk_index, content, locale, heading_path, citation_label, document_title, embedding, authority_score, metadata)"
    )
    .eq("workspace_id", params.workspaceId)
    .eq("source_kind", params.sourceKind)
    .eq("source_record_id", params.sourceRecordId)
    .maybeSingle();
  if (error) throw new Error(`knowledge snapshot failed: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    updatedAt: data.updated_at,
    metadata: data.metadata ?? {},
    chunks: (data.knowledge_chunks ?? []).map(
      (row: Record<string, unknown>) => ({
        chunkIndex: row.chunk_index as number,
        content: row.content as string,
        locale: row.locale as string | null,
        headingPath: row.heading_path as string[] | null,
        citationLabel: row.citation_label as string | null,
        documentTitle: row.document_title as string | null,
        embedding: row.embedding as number[] | string | null,
        authorityScore: row.authority_score as number,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      })
    ),
  };
}

/** One transaction fences concurrent syncs and retains old chunks on any error. */
export async function replaceKnowledgeDocumentChunks(params: {
  document: UpsertKnowledgeDocumentParams;
  expectedUpdatedAt: string | null;
  chunks: CanonicalChunk[];
}): Promise<{ chunksUpserted: number; chunksDeleted: number }> {
  const { document } = params;
  const { data, error } = await supabaseAdmin.rpc(
    "replace_knowledge_document_chunks",
    {
      p_workspace_id: document.workspaceId,
      p_source_kind: document.sourceKind,
      p_source_record_id: document.sourceRecordId,
      p_expected_updated_at: params.expectedUpdatedAt,
      p_document: {
        title: document.title ?? null,
        canonical_url: document.canonicalUrl ?? null,
        locale: document.locale ?? null,
        authority_score: document.authorityScore,
        metadata: document.metadata ?? {},
      },
      p_chunks: params.chunks.map(chunk => ({
        chunk_index: chunk.chunkIndex,
        content: chunk.content,
        locale: chunk.locale,
        heading_path: chunk.headingPath,
        citation_label: chunk.citationLabel,
        document_title: chunk.documentTitle,
        embedding: chunk.embedding,
        authority_score: chunk.authorityScore,
        metadata: chunk.metadata,
      })),
    }
  );
  if (error) throw new Error(`knowledge replacement failed: ${error.message}`);
  if (!data) throw new Error("knowledge replacement returned no result");
  return {
    chunksUpserted: data.chunks_upserted,
    chunksDeleted: data.chunks_deleted,
  };
}

/** SQL sources are reconciled against current source rows inside the transaction. */
export async function reconcileKnowledgeDocuments(params: {
  workspaceId: string;
  sourceKind: string;
  activeSourceRecordIds: string[];
  sourceRecordIds?: string[];
  observedDocuments?: KnowledgeReconciliationSnapshot[];
}): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc(
    "reconcile_knowledge_documents",
    {
      p_workspace_id: params.workspaceId,
      p_source_kind: params.sourceKind,
      p_active_source_record_ids: params.activeSourceRecordIds,
      p_source_record_ids: params.sourceRecordIds ?? null,
      p_observed_documents:
        params.observedDocuments?.map(document => ({
          id: document.id,
          updated_at: document.updatedAt,
          source_record_id: document.sourceRecordId,
        })) ?? null,
    }
  );
  if (error)
    throw new Error(`knowledge reconciliation failed: ${error.message}`);
  return Number(data ?? 0);
}

export async function startKnowledgeSyncRun(
  params: StartKnowledgeSyncRunParams
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("knowledge_sync_runs")
    .insert({
      workspace_id: params.workspaceId,
      source_kind: params.sourceKind,
      status: "running",
      metadata: params.metadata ?? {},
    })
    .select("id")
    .single();

  if (error) {
    return null;
  }

  return data?.id ?? null;
}

export async function finishKnowledgeSyncRun(
  params: FinishKnowledgeSyncRunParams
): Promise<void> {
  await supabaseAdmin
    .from("knowledge_sync_runs")
    .update({
      status: params.status,
      finished_at: new Date().toISOString(),
      documents_touched: params.documentsTouched,
      chunks_upserted: params.chunksUpserted,
      chunks_deleted: params.chunksDeleted,
      error_message: params.errorMessage ?? null,
    })
    .eq("id", params.runId);
}
